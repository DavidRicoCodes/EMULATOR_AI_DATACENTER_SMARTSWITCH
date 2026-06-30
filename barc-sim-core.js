(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.BARCResearchSim = api.BARCResearchSim;
    root.BARCSimInternals = api;
})(typeof self !== 'undefined' ? self : this, function () {
    const COLOR_NAMES = ['red', 'green', 'blue', 'orange'];
    const COLOR_LABELS = ['Red', 'Green', 'Blue', 'Orange'];

    function makeRng(seed) {
        let state = (seed >>> 0) || 1;
        return function rng() {
            state = (1664525 * state + 1013904223) >>> 0;
            return state / 0x100000000;
        };
    }

    function percentile(values, pct) {
        const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
        if (!sorted.length) return null;
        return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * pct / 100) - 1)];
    }

    function clonePacket(packet) {
        return {
            id: packet.id,
            kind: packet.kind,
            sizeBlocks: packet.sizeBlocks,
            colorIndex: packet.colorIndex,
            collectiveId: packet.collectiveId,
            caId: packet.caId,
            sourceId: packet.sourceId,
            seqNo: packet.seqNo,
            direction: packet.direction,
            createdTick: packet.createdTick,
            intendedReceivers: packet.intendedReceivers ? packet.intendedReceivers.slice() : [],
            targetHostId: packet.targetHostId || null,
            targetSwitchId: packet.targetSwitchId || null,
            droppedSwitchId: packet.droppedSwitchId || null,
            droppedPortKey: packet.droppedPortKey || null,
            affectedPortKeys: packet.affectedPortKeys ? packet.affectedPortKeys.slice() : [],
            dropReportId: packet.dropReportId || null,
            attempt: packet.attempt || 0,
            repairContext: packet.repairContext ? Object.assign({}, packet.repairContext) : null,
            reportTransmission: packet.reportTransmission || null,
            repairId: packet.repairId || null,
            feedbackId: packet.feedbackId || null,
            feedbackDelayTicks: packet.feedbackDelayTicks || 0,
            newRate: packet.newRate === undefined ? null : packet.newRate,
            sourcePortKey: packet.sourcePortKey || null,
            lossless: !!packet.lossless,
            originalPacketId: packet.originalPacketId || null,
            unicastRoute: packet.unicastRoute || null
        };
    }

    class SimNode {
        constructor(id, type, meta) {
            this.id = id;
            this.type = type;
            this.meta = meta || {};
            this.x = 0;
            this.y = 0;
            this.w = 100;
            this.h = 32;
            this.upPorts = [];
            this.downPorts = [];
            this.colorIndex = null;
            this.pending = 0;
            this.completed = 0;
            this.active = false;
            this.receivedStats = {};
            this.fctStats = {};
            this.receivedSeqs = {};
            this.nextSeqByColor = {};
            this.egressVectors = {};
            this.startOffsetTicks = 0;
            this.activationTick = null;
            this.originalTxCompleteTick = null;
            this.txCredit = 0;
            this.txPacingPhase = 0;
            this.configuredRate = 0;
        }
    }

    class Port {
        constructor(id, sourceNode, targetNode, offsetX, offsetY, role) {
            this.id = id;
            this.sourceNode = sourceNode;
            this.targetNode = targetNode;
            this.targetPort = null;
            this.offsetX = offsetX;
            this.offsetY = offsetY;
            this.role = role || 'unknown';
            this.queue = [];
            this.activeColor = null;
            this._inflightCount = 0;
            this.lastTraversed = 0;
            this.lastQueueDepth = 0;
            this.reachableCounts = {};
        }

        get key() {
            return `${this.sourceNode.id}.${this.id}`;
        }

        getCenter() {
            return { x: this.sourceNode.x + this.offsetX, y: this.sourceNode.y + this.offsetY };
        }
    }

    class BARCResearchSim {
        constructor(options) {
            this.options = Object.assign({
                capacity: 10,
                bufferLimit: 64,
                seed: 1,
                enableEventLog: true,
                maxEventLogEntries: 200000,
                enableRecovery: true,
                controlPacketBlocks: 0.05,
                dataPacketBlocks: 1,
                repairPacketBlocks: 1,
                maxRepairAttempts: null,
                dropReportRetryBaseTicks: 8,
                dropReportRetryMaxTicks: 128,
                storageMode: 'full'
            }, options || {});

            this.capacity = this.options.capacity;
            this.bufferLimit = this.options.bufferLimit;
            this.rng = makeRng(this.options.seed);
            this.tenantRates = [10, 10, 10, 10];
            this.hostRateOverrides = {};
            this.adaptiveRateControl = null;
            this.adaptiveRateHistory = [];
            this.lastAdaptiveDropCount = 0;
            this.adaptiveStableTicks = 0;
            this.adaptiveFeedback = null;
            this.pendingFeedbackUpdates = [];
            this.feedbackPortState = {};
            this.feedbackLedger = [];
            this.totalFeedbackReports = 0;
            this.totalRateUpdates = 0;
            this.totalAdaptiveControlBlocks = 0;
            this.dropByInterfaceCounters = {};
            this.dropByCollectiveCounters = {};
            this.dropByLayerCounters = {};
            this.dropByKindCounters = {};
            this.repairById = {};
            this.repairByReportId = {};
            this.dropById = {};
            this.lastRepairCompletedTick = 0;
            this.recoveryLatencySamples = [];
            this.acknowledgedReportIds = new Set();
            this.losslessAdmissionControl = false;
            this.tickAdmissionLoad = {};
            this.pendingLosslessForwards = [];
            this.admissionLoadByHost = {};
            this.hostPayloadSize = 100;
            this.currentTick = 0;
            this.appMode = 'setup';
            this.isSequentialMode = false;
            this.seqHostsByColor = {};
            this.seqCurrentIndex = 0;
            this.inflight = [];
            this.dropEvents = [];
            this.dropLedger = [];
            this.pendingDropReports = [];
            this.pendingDropReportMap = {};
            this.pendingSourceRepairs = [];
            this.controlLedger = [];
            this.repairLedger = [];
            this.eventLog = [];
            this.linkUtilizationByTick = [];
            this.hotLinkCounters = {};
            this.packetStore = {};
            this.totalInjected = 0;
            this.totalDelivered = 0;
            this.totalDrops = 0;
            this.totalRepairsInjected = 0;
            this.totalControlReports = 0;
            this.totalControlBlocks = 0;
            this.totalRepairBlocks = 0;
            this.unrecoveredPackets = 0;
            this.runName = 'interactive';
            this.eventId = 0;
            this.reportSequence = 0;
            this.runtimeStartedAtMs = null;
            this.runtimeTimeoutReason = null;
            this.runtimeWallClockLimitMs = null;

            this.allNodes = [];
            this.hosts = [];
            this.edges = [];
            this.aggs = [];
            this.cores = [];
            this.allLinks = [];
            this.collectives = [];
            this.buildTopology();
            this.configureCollectives();
        }

        setSeed(seed) {
            this.options.seed = seed;
            this.rng = makeRng(seed);
        }

        configureCollectives() {
            this.collectives = COLOR_NAMES.map((name, colorIndex) => {
                const rootId = `SS${colorIndex}`;
                return {
                    colorIndex,
                    id: name,
                    label: COLOR_LABELS[colorIndex],
                    caId: `CA_${name.toUpperCase()}_${rootId}`,
                    rootId,
                    rsUpPortIndex: colorIndex < 2 ? 0 : 1,
                    fsUpPortIndex: colorIndex % 2,
                    assumedControlPlane: 'preconfigured'
                };
            });
        }

        buildTopology() {
            this.allNodes = [];
            this.cores = [];
            this.aggs = [];
            this.edges = [];
            this.hosts = [];
            this.allLinks = [];

            for (let i = 0; i < 4; i++) {
                const n = new SimNode(`SS${i}`, 'SS', { spineIndex: i });
                this.cores.push(n);
                this.allNodes.push(n);
            }

            for (let p = 0; p < 4; p++) {
                for (let idx = 0; idx < 2; idx++) {
                    const agg = new SimNode(`FS_${p}_${idx}`, 'FS', { pod: p, fabricIndex: idx });
                    const edge = new SimNode(`RS_${p}_${idx}`, 'RS', { pod: p, rack: idx });
                    this.aggs.push(agg);
                    this.edges.push(edge);
                    this.allNodes.push(agg, edge);
                }

                for (let idx = 0; idx < 4; idx++) {
                    const rack = idx < 2 ? 0 : 1;
                    const hostInRack = idx % 2;
                    const h = new SimNode(`H_${p}_${idx}`, 'Host', { pod: p, rack, hostInRack, hostIndexInPod: idx });
                    this.hosts.push(h);
                    this.allNodes.push(h);
                }
            }

            for (const n of this.allNodes) {
                if (n.type === 'FS' || n.type === 'RS') {
                    n.upPorts.push(new Port('p0', n, null, -20, -16, 'up'));
                    n.upPorts.push(new Port('p1', n, null, 20, -16, 'up'));
                    n.downPorts.push(new Port('p2', n, null, -20, 16, 'down'));
                    n.downPorts.push(new Port('p3', n, null, 20, 16, 'down'));
                } else if (n.type === 'SS') {
                    n.downPorts.push(new Port('p0', n, null, -30, 16, 'down'));
                    n.downPorts.push(new Port('p1', n, null, -10, 16, 'down'));
                    n.downPorts.push(new Port('p2', n, null, 10, 16, 'down'));
                    n.downPorts.push(new Port('p3', n, null, 30, 16, 'down'));
                } else if (n.type === 'Host') {
                    n.upPorts.push(new Port('pU', n, null, 0, -16, 'host-up'));
                }
            }

            for (let p = 0; p < 4; p++) {
                const fs0 = this.aggs[p * 2 + 0];
                const fs1 = this.aggs[p * 2 + 1];
                const rs0 = this.edges[p * 2 + 0];
                const rs1 = this.edges[p * 2 + 1];

                this.linkNodes(fs0, this.cores[0], 0, p);
                this.linkNodes(fs0, this.cores[1], 1, p);
                this.linkNodes(fs1, this.cores[2], 0, p);
                this.linkNodes(fs1, this.cores[3], 1, p);

                this.linkNodes(rs0, fs0, 0, 0);
                this.linkNodes(rs1, fs0, 0, 1);
                this.linkNodes(rs0, fs1, 1, 0);
                this.linkNodes(rs1, fs1, 1, 1);

                const h0 = this.hosts[p * 4 + 0];
                const h1 = this.hosts[p * 4 + 1];
                const h2 = this.hosts[p * 4 + 2];
                const h3 = this.hosts[p * 4 + 3];
                this.linkNodes(h0, rs0, 0, 0);
                this.linkNodes(h1, rs0, 0, 1);
                this.linkNodes(h2, rs1, 0, 0);
                this.linkNodes(h3, rs1, 0, 1);
            }
        }

        linkNodes(childNode, parentNode, upPortIdxOnChild, downPortIdxOnParent) {
            const pUp = childNode.upPorts[upPortIdxOnChild];
            const pDown = parentNode.downPorts[downPortIdxOnParent];
            pUp.targetNode = parentNode;
            pDown.targetNode = childNode;
            pUp.targetPort = pDown;
            pDown.targetPort = pUp;
            this.allLinks.push({ id: `${pUp.key}<->${pDown.key}`, a: pUp, b: pDown });
        }

        setHostColor(hostIdOrIndex, colorIndex) {
            const host = typeof hostIdOrIndex === 'number' ? this.hosts[hostIdOrIndex] : this.hosts.find(h => h.id === hostIdOrIndex);
            if (!host) return;
            host.colorIndex = colorIndex === null || colorIndex === undefined ? null : Number(colorIndex);
        }

        setTenantRate(colorIndex, rate) {
            this.tenantRates[colorIndex] = Number(rate);
        }

        switchToRunMode() {
            if (this.appMode === 'setup') {
                this.appMode = 'run';
            }
            this.computeForwardingState();
        }

        resetSetup() {
            this.appMode = 'setup';
            this.resetTraffic();
            for (const h of this.hosts) {
                h.colorIndex = null;
            }
        }

        resetTraffic() {
            this.currentTick = 0;
            this.isSequentialMode = false;
            this.seqHostsByColor = {};
            this.seqCurrentIndex = 0;
            this.inflight = [];
            this.dropEvents = [];
            this.dropLedger = [];
            this.pendingDropReports = [];
            this.pendingDropReportMap = {};
            this.pendingSourceRepairs = [];
            this.controlLedger = [];
            this.repairLedger = [];
            this.eventLog = [];
            this.linkUtilizationByTick = [];
            this.hotLinkCounters = {};
            this.packetStore = {};
            this.totalInjected = 0;
            this.totalDelivered = 0;
            this.totalDrops = 0;
            this.totalRepairsInjected = 0;
            this.totalControlReports = 0;
            this.totalControlBlocks = 0;
            this.totalRepairBlocks = 0;
            this.unrecoveredPackets = 0;
            this.hostRateOverrides = {};
            this.adaptiveRateControl = null;
            this.adaptiveRateHistory = [];
            this.lastAdaptiveDropCount = 0;
            this.adaptiveStableTicks = 0;
            this.adaptiveFeedback = null;
            this.pendingFeedbackUpdates = [];
            this.feedbackPortState = {};
            this.feedbackLedger = [];
            this.totalFeedbackReports = 0;
            this.totalRateUpdates = 0;
            this.totalAdaptiveControlBlocks = 0;
            this.dropByInterfaceCounters = {};
            this.dropByCollectiveCounters = {};
            this.dropByLayerCounters = {};
            this.dropByKindCounters = {};
            this.repairById = {};
            this.repairByReportId = {};
            this.dropById = {};
            this.lastRepairCompletedTick = 0;
            this.recoveryLatencySamples = [];
            this.acknowledgedReportIds = new Set();
            this.losslessAdmissionControl = false;
            this.tickAdmissionLoad = {};
            this.pendingLosslessForwards = [];
            this.admissionLoadByHost = {};
            this.eventId = 0;
            this.reportSequence = 0;
            this.runtimeStartedAtMs = null;
            this.runtimeTimeoutReason = null;
            this.runtimeWallClockLimitMs = null;

            for (const n of this.allNodes) {
                if (n.type === 'Host') {
                    n.pending = 0;
                    n.completed = 0;
                    n.active = false;
                    n.receivedStats = {};
                    n.fctStats = {};
                    n.receivedSeqs = {};
                    n.nextSeqByColor = {};
                    n.originalTxCompleteTick = null;
                    n.startOffsetTicks = 0;
                    n.activationTick = null;
                    n.txCredit = 0;
                    n.txPacingPhase = 0;
                    n.configuredRate = 0;
                }
                for (const p of n.upPorts.concat(n.downPorts)) {
                    p.queue = [];
                    p.activeColor = null;
                    p._inflightCount = 0;
                    p.lastTraversed = 0;
                    p.lastQueueDepth = 0;
                }
            }
        }

        computeForwardingState() {
            const globalCounts = { 0: 0, 1: 0, 2: 0, 3: 0 };
            for (const h of this.hosts) {
                if (h.colorIndex !== null) globalCounts[h.colorIndex]++;
            }

            for (const rs of this.edges) {
                const rsTotals = {};
                for (const dp of rs.downPorts) {
                    const h = dp.targetNode;
                    dp.reachableCounts = {};
                    if (h.colorIndex !== null) {
                        dp.reachableCounts[h.colorIndex] = 1;
                        rsTotals[h.colorIndex] = (rsTotals[h.colorIndex] || 0) + 1;
                    }
                }
                rs.needsUp = {};
                rs.egressVectors = {};
                for (let c = 0; c < 4; c++) {
                    rs.needsUp[c] = (globalCounts[c] || 0) > (rsTotals[c] || 0);
                    rs.egressVectors[c] = this.computeNodeEgressVector(rs, c);
                }
            }

            for (const fs of this.aggs) {
                const fsTotals = {};
                for (const dp of fs.downPorts) {
                    const rs = dp.targetNode;
                    dp.reachableCounts = {};
                    for (const rsdp of rs.downPorts) {
                        for (const c in rsdp.reachableCounts) {
                            dp.reachableCounts[c] = (dp.reachableCounts[c] || 0) + rsdp.reachableCounts[c];
                        }
                    }
                    for (const c in dp.reachableCounts) {
                        fsTotals[c] = (fsTotals[c] || 0) + dp.reachableCounts[c];
                    }
                }
                fs.needsUp = {};
                fs.egressVectors = {};
                for (let c = 0; c < 4; c++) {
                    fs.needsUp[c] = (globalCounts[c] || 0) > (fsTotals[c] || 0);
                    fs.egressVectors[c] = this.computeNodeEgressVector(fs, c);
                }
            }

            for (const ss of this.cores) {
                ss.needsUp = {};
                ss.egressVectors = {};
                for (const dp of ss.downPorts) {
                    const fs = dp.targetNode;
                    dp.reachableCounts = {};
                    for (const fsdp of fs.downPorts) {
                        for (const c in fsdp.reachableCounts) {
                            dp.reachableCounts[c] = (dp.reachableCounts[c] || 0) + fsdp.reachableCounts[c];
                        }
                    }
                }
                for (let c = 0; c < 4; c++) {
                    ss.egressVectors[c] = this.computeNodeEgressVector(ss, c);
                }
            }
        }

        computeNodeEgressVector(node, colorIndex) {
            const vector = {};
            for (const p of node.downPorts) {
                vector[p.id] = !!(p.reachableCounts && p.reachableCounts[colorIndex] > 0);
            }
            if (node.upPorts && node.upPorts.length) {
                for (const p of node.upPorts) vector[p.id] = false;
                if (node.needsUp && node.needsUp[colorIndex]) {
                    const idx = node.type === 'RS'
                        ? this.collectives[colorIndex].rsUpPortIndex
                        : this.collectives[colorIndex].fsUpPortIndex;
                    if (node.upPorts[idx]) vector[node.upPorts[idx].id] = true;
                }
            }
            return vector;
        }

        triggerAll(payloadSize) {
            this.switchToRunMode();
            this.isSequentialMode = false;
            this.hostPayloadSize = payloadSize || this.hostPayloadSize;
            const activeHosts = this.hosts.filter(h => h.colorIndex !== null);
            for (let i = 0; i < activeHosts.length; i++) {
                activeHosts[i].txPacingPhase = activeHosts.length ? i / activeHosts.length : 0;
            }
            for (const h of this.hosts) {
                if (h.colorIndex !== null) {
                    h.pending = this.hostPayloadSize;
                    h.active = (h.startOffsetTicks || 0) <= this.currentTick;
                    h.activationTick = h.active ? this.currentTick : null;
                    h.originalTxCompleteTick = null;
                    h.txCredit = h.txPacingPhase;
                }
            }
        }

        triggerSequential(payloadSize) {
            this.switchToRunMode();
            this.isSequentialMode = true;
            this.seqCurrentIndex = 0;
            this.hostPayloadSize = payloadSize || this.hostPayloadSize;
            this.seqHostsByColor = { 0: [], 1: [], 2: [], 3: [] };
            for (const h of this.hosts) {
                if (h.colorIndex !== null) {
                    h.txPacingPhase = 0;
                    this.seqHostsByColor[h.colorIndex].push(h);
                }
            }
            for (const c in this.seqHostsByColor) this.shuffleArray(this.seqHostsByColor[c]);
            this.triggerNextInSequence();
        }

        shuffleArray(array) {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(this.rng() * (i + 1));
                const tmp = array[i];
                array[i] = array[j];
                array[j] = tmp;
            }
        }

        triggerNextInSequence() {
            let triggeredAny = false;
            for (const c in this.seqHostsByColor) {
                const arr = this.seqHostsByColor[c];
                if (this.seqCurrentIndex < arr.length) {
                    const h = arr[this.seqCurrentIndex];
                    h.pending = this.hostPayloadSize;
                    h.active = true;
                    h.activationTick = this.currentTick;
                    h.originalTxCompleteTick = null;
                    h.txCredit = h.txPacingPhase;
                    triggeredAny = true;
                }
            }
            if (!triggeredAny) this.isSequentialMode = false;
        }

        checkSequentialProgress() {
            if (!this.isSequentialMode) return;

            let currentBatchDone = true;
            let activeInBatch = false;
            for (const c in this.seqHostsByColor) {
                const arr = this.seqHostsByColor[c];
                if (this.seqCurrentIndex < arr.length) {
                    activeInBatch = true;
                    const h = arr[this.seqCurrentIndex];
                    if (h.pending > 0 || h.active) {
                        currentBatchDone = false;
                        break;
                    }
                }
            }

            if (activeInBatch && currentBatchDone && !this.hasQueuedData()) {
                this.seqCurrentIndex++;
                this.triggerNextInSequence();
            } else if (!activeInBatch) {
                this.isSequentialMode = false;
            }
        }

        makeMulticastPacket(host) {
            const colorIndex = host.colorIndex;
            const seqNo = host.nextSeqByColor[colorIndex] || 0;
            host.nextSeqByColor[colorIndex] = seqNo + 1;
            const collective = this.collectives[colorIndex];
            const intendedReceivers = this.hosts
                .filter(h => h.colorIndex === colorIndex && h.id !== host.id)
                .map(h => h.id);

            return {
                id: `${collective.id}:${host.id}:${seqNo}`,
                kind: 'data-multicast',
                sizeBlocks: this.options.dataPacketBlocks,
                colorIndex,
                collectiveId: collective.id,
                caId: collective.caId,
                sourceId: host.id,
                seqNo,
                direction: 'up',
                createdTick: this.currentTick,
                intendedReceivers,
                targetHostId: null,
                originalPacketId: null,
                lossless: this.losslessAdmissionControl,
                unicastRoute: null
            };
        }

        makeUnicastPacket(sourceNodeId, targetHostId, originalPacket) {
            const colorIndex = originalPacket ? originalPacket.colorIndex : null;
            const collective = colorIndex !== null ? this.collectives[colorIndex] : null;
            const seqNo = originalPacket ? originalPacket.seqNo : this.totalRepairsInjected;
            const logicalSourceId = originalPacket && originalPacket.sourceId ? originalPacket.sourceId : sourceNodeId;
            return {
                id: `repair:${sourceNodeId}:${targetHostId}:${originalPacket ? originalPacket.id : seqNo}:${this.totalRepairsInjected}`,
                kind: 'repair-to-switch',
                sizeBlocks: this.options.repairPacketBlocks,
                colorIndex,
                collectiveId: collective ? collective.id : 'repair',
                caId: collective ? collective.caId : null,
                sourceId: logicalSourceId,
                seqNo,
                direction: 'unicast',
                createdTick: this.currentTick,
                intendedReceivers: [targetHostId],
                targetHostId,
                repairOriginNodeId: sourceNodeId,
                originalPacketId: originalPacket ? originalPacket.id : null,
                unicastRoute: { rsUpPortIndex: 0, fsUpPortIndex: 0 }
            };
        }

        enqueueUnicastRepair(sourceNodeId, targetHostId, originalPacket) {
            const sourceNode = this.allNodes.find(n => n.id === sourceNodeId);
            if (!sourceNode) throw new Error(`Unknown unicast repair source node: ${sourceNodeId}`);
            const packet = this.makeUnicastPacket(sourceNodeId, targetHostId, originalPacket || null);
            const nextPort = this.nextUnicastPort(sourceNode, packet);
            if (!nextPort) throw new Error(`No stateless unicast route from ${sourceNodeId} to ${targetHostId}`);
            this.totalRepairsInjected++;
            this.enqueuePacket(nextPort, packet, 'repair_unicast');
            this.logEvent('repair-inject', { packetId: packet.id, sourceNodeId, targetHostId, originalPacketId: packet.originalPacketId });
            return packet;
        }

        makeDropReportPacket(report) {
            return {
                id: `drop-report:${report.id}:${(report.sendCount || 0) + 1}`,
                kind: 'drop-report',
                sizeBlocks: this.options.controlPacketBlocks,
                colorIndex: report.colorIndex,
                collectiveId: report.collectiveId,
                caId: report.caId,
                sourceId: report.sourceHost,
                seqNo: report.seqNo,
                direction: 'unicast',
                createdTick: this.currentTick,
                intendedReceivers: [report.sourceHost],
                targetHostId: report.sourceHost,
                targetSwitchId: null,
                droppedSwitchId: report.droppedSwitchId,
                droppedPortKey: report.droppedPortKey,
                affectedPortKeys: report.affectedPortKeys.slice(),
                affectedHosts: report.affectedHosts.slice(),
                dropReportId: report.id,
                reportTransmission: (report.sendCount || 0) + 1,
                attempt: report.attempt,
                originalPacketId: report.originalPacketId,
                repairContext: {
                    droppedSwitchId: report.droppedSwitchId,
                    droppedPortKey: report.droppedPortKey,
                    affectedPortKeys: report.affectedPortKeys.slice(),
                    affectedHosts: report.affectedHosts.slice(),
                    dropIds: report.dropIds.slice()
                },
                unicastRoute: { rsUpPortIndex: 0, fsUpPortIndex: 0 }
            };
        }

        makeRepairToSwitchPacket(sourceHost, reportPacket, originalPacket) {
            const context = reportPacket.repairContext || {};
            return {
                id: `repair-to-switch:${reportPacket.dropReportId}:${this.totalRepairsInjected}`,
                kind: 'repair-to-switch',
                sizeBlocks: this.options.repairPacketBlocks,
                colorIndex: reportPacket.colorIndex,
                collectiveId: reportPacket.collectiveId,
                caId: reportPacket.caId,
                sourceId: originalPacket ? originalPacket.sourceId : reportPacket.sourceId,
                seqNo: reportPacket.seqNo,
                direction: 'unicast',
                createdTick: this.currentTick,
                intendedReceivers: context.affectedHosts ? context.affectedHosts.slice() : [],
                targetHostId: null,
                targetSwitchId: context.droppedSwitchId,
                droppedSwitchId: context.droppedSwitchId,
                droppedPortKey: context.droppedPortKey,
                affectedPortKeys: context.affectedPortKeys ? context.affectedPortKeys.slice() : [],
                dropReportId: reportPacket.dropReportId,
                attempt: reportPacket.attempt,
                originalPacketId: reportPacket.originalPacketId,
                repairContext: Object.assign({}, context),
                unicastRoute: { rsUpPortIndex: 0, fsUpPortIndex: 0 }
            };
        }

        makeRepairSubtreePacket(repairPacket, direction) {
            return {
                id: `repair-subtree:${repairPacket.dropReportId}:${repairPacket.droppedPortKey}:${this.totalRepairsInjected}`,
                kind: 'repair-subtree',
                sizeBlocks: this.options.repairPacketBlocks,
                colorIndex: repairPacket.colorIndex,
                collectiveId: repairPacket.collectiveId,
                caId: repairPacket.caId,
                sourceId: repairPacket.sourceId,
                seqNo: repairPacket.seqNo,
                direction,
                createdTick: this.currentTick,
                intendedReceivers: repairPacket.intendedReceivers ? repairPacket.intendedReceivers.slice() : [],
                targetHostId: null,
                targetSwitchId: null,
                droppedSwitchId: repairPacket.droppedSwitchId,
                droppedPortKey: repairPacket.droppedPortKey,
                affectedPortKeys: repairPacket.affectedPortKeys ? repairPacket.affectedPortKeys.slice() : [],
                dropReportId: repairPacket.dropReportId,
                repairId: repairPacket.id,
                attempt: repairPacket.attempt,
                originalPacketId: repairPacket.originalPacketId,
                repairContext: repairPacket.repairContext ? Object.assign({}, repairPacket.repairContext) : null,
                unicastRoute: null
            };
        }

        makeCongestionReportPacket(port, colorIndex) {
            const collective = this.collectives[colorIndex];
            const id = `feedback:${port.key}:${collective.id}:${this.currentTick}`;
            return {
                id: `congestion-report:${id}`,
                kind: 'congestion-report',
                sizeBlocks: this.options.controlPacketBlocks,
                colorIndex,
                collectiveId: collective.id,
                caId: collective.caId,
                sourceId: port.sourceNode.id,
                seqNo: this.currentTick,
                direction: 'unicast',
                createdTick: this.currentTick,
                intendedReceivers: [],
                targetHostId: null,
                targetSwitchId: collective.rootId,
                feedbackId: id,
                feedbackDelayTicks: this.adaptiveFeedback.processingDelayTicks,
                sourcePortKey: port.key,
                originalPacketId: null,
                unicastRoute: { rsUpPortIndex: 0, fsUpPortIndex: 0 }
            };
        }

        makeRateUpdatePacket(root, host, feedbackPacket, newRate) {
            return {
                id: `rate-update:${feedbackPacket.feedbackId}:${host.id}`,
                kind: 'rate-update',
                sizeBlocks: this.options.controlPacketBlocks,
                colorIndex: feedbackPacket.colorIndex,
                collectiveId: feedbackPacket.collectiveId,
                caId: feedbackPacket.caId,
                sourceId: root.id,
                seqNo: feedbackPacket.seqNo,
                direction: 'unicast',
                createdTick: this.currentTick,
                intendedReceivers: [host.id],
                targetHostId: host.id,
                targetSwitchId: null,
                feedbackId: feedbackPacket.feedbackId,
                feedbackDelayTicks: feedbackPacket.feedbackDelayTicks,
                sourcePortKey: feedbackPacket.sourcePortKey,
                newRate,
                originalPacketId: null,
                unicastRoute: { rsUpPortIndex: 0, fsUpPortIndex: 0 }
            };
        }

        packetSize(packet) {
            return Number(packet && packet.sizeBlocks !== undefined ? packet.sizeBlocks : 1);
        }

        queueOccupancy(port) {
            if (!port || !port.queue) return 0;
            return port.queue.reduce((sum, packet) => sum + this.packetSize(packet), 0);
        }

        canEnqueuePacket(port, packet) {
            if (!port) return false;
            if (this.bufferLimit === null || this.bufferLimit === undefined) return true;
            return this.queueOccupancy(port) + this.packetSize(packet) <= this.bufferLimit + 1e-9;
        }

        step() {
            this.currentTick++;
            this.deliverInflight();

            for (const n of this.allNodes) {
                for (const p of n.upPorts.concat(n.downPorts)) {
                    p._inflightCount = 0;
                    p.lastTraversed = 0;
                    p.lastQueueDepth = this.queueOccupancy(p);
                }
            }

            this.updateAdaptiveRates();
            this.updateFeedbackRates();
            this.tickAdmissionLoad = {};
            this.injectHostTraffic();
            this.releasePendingDropReports();
            this.releasePendingSourceRepairs();
            this.detectCongestionFeedback();
            this.releasePendingFeedbackUpdates();
            this.releasePendingLosslessForwards();
            this.schedulePorts();
            this.recordTickUtilization();
            this.checkSequentialProgress();
        }

        injectHostTraffic() {
            for (const h of this.hosts) {
                if (h.pending > 0 && !h.active && !this.isSequentialMode && (h.startOffsetTicks || 0) <= this.currentTick) {
                    h.active = true;
                    h.activationTick = this.currentTick;
                    h.txCredit = h.txPacingPhase;
                    this.logEvent('host-offset-release', {
                        hostId: h.id,
                        collectiveId: h.colorIndex === null ? null : this.collectives[h.colorIndex].id,
                        startOffsetTicks: h.startOffsetTicks || 0
                    });
                }
                if (h.pending > 0 && h.active) {
                    const currentRate = this.hostInjectionRate(h);
                    h.configuredRate = currentRate;
                    h.txCredit += Math.max(0, currentRate);
                    const available = Math.min(h.pending, Math.floor(h.txCredit + 1e-9));
                    let sent = 0;
                    for (let i = 0; i < available; i++) {
                        if (!this.reserveLosslessAdmission(h)) break;
                        const packet = this.makeMulticastPacket(h);
                        this.packetStore[packet.id] = clonePacket(packet);
                        this.totalInjected++;
                        sent++;
                        this.enqueuePacket(h.upPorts[0], packet, 'host_injection');
                        this.logEvent('inject', {
                            packetId: packet.id,
                            sourceHost: h.id,
                            collectiveId: packet.collectiveId,
                            seqNo: packet.seqNo
                        });
                    }
                    h.txCredit -= sent;
                    h.pending -= sent;
                    if (h.pending === 0) {
                        h.active = false;
                        if (h.originalTxCompleteTick === null) h.originalTxCompleteTick = this.currentTick;
                    }
                }
            }
        }

        reserveLosslessAdmission(host) {
            if (!this.losslessAdmissionControl) return true;
            let load = this.admissionLoadByHost[host.id];
            if (!load) {
                const collective = this.collectives[host.colorIndex];
                const packet = this.makeAdvisorPacket(host, collective);
                load = {};
                this.tracePacketLoadFromPort(host.upPorts[0], packet, load, new Set());
                this.admissionLoadByHost[host.id] = load;
            }
            const budget = Math.min(this.capacity, this.bufferLimit);
            for (const [linkId, blocks] of Object.entries(load)) {
                if ((this.tickAdmissionLoad[linkId] || 0) + blocks > budget + 1e-9) return false;
            }
            for (const [linkId, blocks] of Object.entries(load)) {
                this.tickAdmissionLoad[linkId] = (this.tickAdmissionLoad[linkId] || 0) + blocks;
            }
            return true;
        }

        hostInjectionRate(host) {
            if (!host || host.colorIndex === null) return 0;
            if (Object.prototype.hasOwnProperty.call(this.hostRateOverrides, host.id)) {
                return Math.max(0, Number(this.hostRateOverrides[host.id]) || 0);
            }
            if (this.adaptiveRateControl && this.adaptiveRateControl.currentRates) {
                return Math.max(0, Number(this.adaptiveRateControl.currentRates[host.colorIndex]) || 0);
            }
            return Math.max(0, Number(this.tenantRates[host.colorIndex]) || 0);
        }

        updateAdaptiveRates() {
            const control = this.adaptiveRateControl;
            if (!control || !control.enabled) return;

            const newDrops = this.totalDrops - this.lastAdaptiveDropCount;
            this.lastAdaptiveDropCount = this.totalDrops;
            let maxQueueRatio = 0;
            if (this.bufferLimit > 0) {
                for (const node of this.allNodes) {
                    for (const port of node.upPorts.concat(node.downPorts)) {
                        maxQueueRatio = Math.max(maxQueueRatio, this.queueOccupancy(port) / this.bufferLimit);
                    }
                }
            }

            const congested = newDrops > 0 || maxQueueRatio >= control.queueHighWatermark;
            let changed = false;
            if (congested) {
                this.adaptiveStableTicks = 0;
                for (let color = 0; color < this.tenantRates.length; color++) {
                    if (!control.baseRates[color]) continue;
                    const minimum = control.baseRates[color] * control.minMultiplier;
                    const next = Math.max(minimum, control.currentRates[color] * control.decreaseFactor);
                    if (Math.abs(next - control.currentRates[color]) > 1e-9) changed = true;
                    control.currentRates[color] = next;
                }
            } else {
                this.adaptiveStableTicks++;
                if (this.adaptiveStableTicks >= control.increaseEveryTicks) {
                    this.adaptiveStableTicks = 0;
                    for (let color = 0; color < this.tenantRates.length; color++) {
                        if (!control.baseRates[color]) continue;
                        const maximum = control.baseRates[color] * control.maxMultiplier;
                        const next = Math.min(maximum, control.currentRates[color] + control.baseRates[color] * control.increaseStep);
                        if (Math.abs(next - control.currentRates[color]) > 1e-9) changed = true;
                        control.currentRates[color] = next;
                    }
                }
            }

            if (changed || congested) {
                this.adaptiveRateHistory.push({
                    tick: this.currentTick,
                    reason: congested ? (newDrops > 0 ? 'drop' : 'queue') : 'increase',
                    newDrops,
                    maxQueueRatio,
                    rates: control.currentRates.slice()
                });
            }
        }

        updateFeedbackRates() {
            const feedback = this.adaptiveFeedback;
            if (!feedback || !feedback.enabled) return;
            if (this.currentTick % feedback.increaseEveryTicks !== 0) return;
            for (let color = 0; color < feedback.currentRates.length; color++) {
                if (!feedback.baseRates[color]) continue;
                const maximum = feedback.baseRates[color] * feedback.maxMultiplier;
                feedback.currentRates[color] = Math.min(
                    maximum,
                    feedback.currentRates[color] + feedback.baseRates[color] * feedback.increaseStep
                );
            }
            for (const host of this.hosts) {
                if (host.colorIndex === null || !Object.prototype.hasOwnProperty.call(this.hostRateOverrides, host.id)) continue;
                const maximum = feedback.baseRates[host.colorIndex] * feedback.maxMultiplier;
                this.hostRateOverrides[host.id] = Math.min(
                    maximum,
                    this.hostRateOverrides[host.id] + feedback.baseRates[host.colorIndex] * feedback.increaseStep
                );
            }
        }

        detectCongestionFeedback() {
            const feedback = this.adaptiveFeedback;
            if (!feedback || !feedback.enabled) return;
            for (const node of this.allNodes) {
                if (node.type === 'Host') continue;
                for (const port of node.upPorts.concat(node.downPorts)) {
                    const ratio = this.bufferLimit > 0 ? this.queueOccupancy(port) / this.bufferLimit : 0;
                    const state = this.feedbackPortState[port.key] || { high: false, lastReportTick: -Infinity };
                    if (ratio < feedback.lowWatermark) state.high = false;
                    if (!state.high && ratio >= feedback.highWatermark
                        && this.currentTick - state.lastReportTick >= feedback.coalesceTicks) {
                        const colors = new Set(port.queue
                            .filter(packet => Number.isInteger(packet.colorIndex) && packet.colorIndex >= 0)
                            .map(packet => packet.colorIndex));
                        for (const colorIndex of colors) {
                            const packet = this.makeCongestionReportPacket(port, colorIndex);
                            const nextPort = this.nextPortToSwitch(node, packet.targetSwitchId);
                            if (node.id === packet.targetSwitchId) {
                                this.handleCongestionReport(packet, node);
                            } else if (nextPort) {
                                this.enqueuePacket(nextPort, packet, 'adaptive_congestion_report');
                                this.totalFeedbackReports++;
                                this.totalAdaptiveControlBlocks += packet.sizeBlocks;
                                this.feedbackLedger.push({
                                    feedbackId: packet.feedbackId,
                                    kind: packet.kind,
                                    createdTick: this.currentTick,
                                    sourcePortKey: port.key,
                                    collectiveId: packet.collectiveId,
                                    status: 'sent'
                                });
                            }
                        }
                        state.high = true;
                        state.lastReportTick = this.currentTick;
                    }
                    this.feedbackPortState[port.key] = state;
                }
            }
        }

        handleCongestionReport(packet, rootNode) {
            const feedback = this.adaptiveFeedback;
            if (!feedback) return;
            const currentRate = feedback.currentRates[packet.colorIndex] || 0;
            const baseRate = feedback.baseRates[packet.colorIndex] || 0;
            const newRate = Math.max(baseRate * feedback.minMultiplier, currentRate * feedback.decreaseFactor);
            feedback.currentRates[packet.colorIndex] = newRate;
            this.pendingFeedbackUpdates.push({
                packet,
                rootId: rootNode.id,
                releaseTick: this.currentTick + packet.feedbackDelayTicks,
                newRate
            });
            const ledger = this.feedbackLedger.find(item => item.feedbackId === packet.feedbackId);
            if (ledger) {
                ledger.arrivedRootTick = this.currentTick;
                ledger.status = 'processing';
            }
        }

        releasePendingFeedbackUpdates() {
            for (const pending of this.pendingFeedbackUpdates) {
                if (pending.status === 'released' || this.currentTick < pending.releaseTick) continue;
                const root = this.getNodeById(pending.rootId);
                if (!root) continue;
                const hosts = this.hosts.filter(host => host.colorIndex === pending.packet.colorIndex);
                for (const host of hosts) {
                    const packet = this.makeRateUpdatePacket(root, host, pending.packet, pending.newRate);
                    const nextPort = this.nextUnicastPort(root, packet);
                    if (!nextPort) continue;
                    this.enqueuePacket(nextPort, packet, 'adaptive_rate_update');
                    this.totalRateUpdates++;
                    this.totalAdaptiveControlBlocks += packet.sizeBlocks;
                }
                pending.status = 'released';
                pending.releasedTick = this.currentTick;
                const ledger = this.feedbackLedger.find(item => item.feedbackId === pending.packet.feedbackId);
                if (ledger) {
                    ledger.rateUpdateTick = this.currentTick;
                    ledger.newRate = pending.newRate;
                    ledger.status = 'updates-sent';
                }
            }
        }

        schedulePorts() {
            for (const n of this.allNodes) {
                for (const p of n.upPorts.concat(n.downPorts)) {
                    if (p.queue.length === 0) {
                        p.activeColor = null;
                        continue;
                    }

                    let sentBlocks = 0;
                    let majorColor = null;
                    while (p.queue.length > 0) {
                        const nextSize = this.packetSize(p.queue[0]);
                        if (sentBlocks + nextSize > this.capacity + 1e-9) break;
                        const packet = p.queue.shift();
                        this.sendToLink(p, packet);
                        if (majorColor === null && packet.colorIndex !== null) majorColor = packet.colorIndex;
                        sentBlocks += nextSize;
                    }
                    p.activeColor = majorColor;
                }
            }
        }

        sendToLink(sourcePort, packet) {
            if (!sourcePort.targetPort) {
                this.dropBlock(sourcePort, packet, 'missing_target_port');
                return;
            }
            const offset = sourcePort._inflightCount * 0.05;
            sourcePort._inflightCount++;
            sourcePort.lastTraversed += this.packetSize(packet);
            this.inflight.push({
                block: packet,
                sourcePort,
                targetPort: sourcePort.targetPort,
                offset
            });
            this.logEvent('forward', {
                packetId: packet.id,
                kind: packet.kind,
                sourcePort: sourcePort.key,
                targetPort: sourcePort.targetPort.key,
                direction: packet.direction
            });
        }

        enqueuePacket(port, packet, reason, options) {
            const opts = options || {};
            if (!port) {
                if (opts.dropOnFull === false) return false;
                this.dropBlock({ sourceNode: { id: 'unknown' }, id: 'unknown', queue: [], targetPort: null }, packet, 'missing_egress_port');
                return false;
            }
            if (!this.canEnqueuePacket(port, packet)) {
                if (packet && packet.lossless && opts.deferLossless !== false) {
                    this.pendingLosslessForwards.push({ port, packet, reason, createdTick: this.currentTick });
                    this.logEvent('lossless-forward-deferred', {
                        packetId: packet.id,
                        port: port.key,
                        reason
                    });
                    return false;
                }
                if (opts.dropOnFull === false) return false;
                this.dropBlock(port, packet, 'buffer_limit');
                return false;
            }
            port.queue.push(packet);
            this.logEvent('enqueue', {
                packetId: packet.id,
                kind: packet.kind,
                port: port.key,
                queueDepth: port.queue.length,
                queueBlocks: this.queueOccupancy(port),
                sizeBlocks: this.packetSize(packet),
                reason
            });
            return true;
        }

        releasePendingLosslessForwards() {
            if (!this.pendingLosslessForwards.length) return;
            const remaining = [];
            for (const pending of this.pendingLosslessForwards) {
                if (!this.canEnqueuePacket(pending.port, pending.packet)) {
                    remaining.push(pending);
                    continue;
                }
                this.enqueuePacket(
                    pending.port,
                    pending.packet,
                    `${pending.reason}_retry`,
                    { deferLossless: false }
                );
            }
            this.pendingLosslessForwards = remaining;
        }

        deliverInflight() {
            const delivered = this.inflight;
            this.inflight = [];
            for (const item of delivered) this.deliver(item.block, item.targetPort);
        }

        deliver(packet, rxPort) {
            const rxNode = rxPort.sourceNode;
            this.logEvent('arrive', {
                packetId: packet.id,
                kind: packet.kind,
                nodeId: rxNode.id,
                ingressPort: rxPort.id
            });

            if (packet.kind === 'drop-report') {
                this.deliverControlOrRepairUnicast(packet, rxNode);
                return;
            }

            if (packet.kind === 'repair-to-switch') {
                this.deliverControlOrRepairUnicast(packet, rxNode);
                return;
            }

            if (packet.kind === 'congestion-report') {
                if (rxNode.id === packet.targetSwitchId) {
                    this.handleCongestionReport(packet, rxNode);
                } else {
                    const nextPort = this.nextPortToSwitch(rxNode, packet.targetSwitchId);
                    if (!nextPort) this.dropBlock((rxNode.upPorts[0] || rxNode.downPorts[0]), packet, 'feedback_no_route');
                    else this.enqueuePacket(nextPort, packet, 'adaptive_feedback_forward');
                }
                return;
            }

            if (packet.kind === 'rate-update') {
                if (rxNode.type === 'Host' && rxNode.id === packet.targetHostId) {
                    if (this.adaptiveFeedback) {
                        this.hostRateOverrides[rxNode.id] = packet.newRate;
                    }
                    const ledger = this.feedbackLedger.find(item => item.feedbackId === packet.feedbackId);
                    if (ledger) {
                        ledger.firstAppliedTick = ledger.firstAppliedTick === undefined
                            ? this.currentTick
                            : Math.min(ledger.firstAppliedTick, this.currentTick);
                        ledger.lastAppliedTick = this.currentTick;
                        ledger.status = 'applied';
                    }
                } else {
                    const nextPort = this.nextUnicastPort(rxNode, packet);
                    if (!nextPort) this.dropBlock((rxNode.upPorts[0] || rxNode.downPorts[0]), packet, 'feedback_no_route');
                    else this.enqueuePacket(nextPort, packet, 'adaptive_rate_update_forward');
                }
                return;
            }

            if (rxNode.type === 'Host') {
                if (packet.kind === 'repair-subtree') {
                    if (packet.intendedReceivers && packet.intendedReceivers.includes(rxNode.id)) {
                        this.recordHostDelivery(rxNode, packet);
                    }
                } else if (packet.colorIndex === rxNode.colorIndex && packet.sourceId !== rxNode.id) {
                    this.recordHostDelivery(rxNode, packet);
                }
                return;
            }

            if (packet.kind === 'repair-subtree') {
                this.deliverRepairSubtree(packet, rxPort, rxNode);
                return;
            }

            if (rxNode.type === 'RS' || rxNode.type === 'FS') {
                if (packet.direction === 'up') {
                    for (const p of rxNode.downPorts) {
                        if (p === rxPort) continue;
                        if (p.reachableCounts && p.reachableCounts[packet.colorIndex] > 0) {
                            this.enqueuePacket(p, Object.assign(clonePacket(packet), { direction: 'down' }), 'multicast_replication_down');
                        }
                    }
                    if (rxNode.needsUp && rxNode.needsUp[packet.colorIndex]) {
                        const pIdx = rxNode.type === 'RS'
                            ? this.collectives[packet.colorIndex].rsUpPortIndex
                            : this.collectives[packet.colorIndex].fsUpPortIndex;
                        this.enqueuePacket(rxNode.upPorts[pIdx], Object.assign(clonePacket(packet), { direction: 'up' }), 'multicast_continue_up');
                    }
                } else {
                    for (const p of rxNode.downPorts) {
                        if (p.reachableCounts && p.reachableCounts[packet.colorIndex] > 0) {
                            this.enqueuePacket(p, Object.assign(clonePacket(packet), { direction: 'down' }), 'multicast_fanout_down');
                        }
                    }
                }
                return;
            }

            if (rxNode.type === 'SS') {
                for (const p of rxNode.downPorts) {
                    if (p === rxPort) continue;
                    if (p.reachableCounts && p.reachableCounts[packet.colorIndex] > 0) {
                        this.enqueuePacket(p, Object.assign(clonePacket(packet), { direction: 'down' }), 'multicast_spine_fanout');
                    }
                }
            }
        }

        deliverRepairSubtree(packet, rxPort, rxNode) {
            if (rxNode.type === 'RS' || rxNode.type === 'FS') {
                if (packet.direction === 'up') {
                    for (const p of rxNode.downPorts) {
                        if (p === rxPort) continue;
                        if (this.portReachesAnyHost(p, packet.intendedReceivers)) {
                            this.enqueuePacket(p, Object.assign(clonePacket(packet), { direction: 'down' }), 'repair_subtree_down');
                        }
                    }
                    if (this.targetsRemainOutsideDownPorts(rxNode, rxPort, packet.intendedReceivers)) {
                        const pIdx = rxNode.type === 'RS'
                            ? this.collectives[packet.colorIndex].rsUpPortIndex
                            : this.collectives[packet.colorIndex].fsUpPortIndex;
                        this.enqueuePacket(rxNode.upPorts[pIdx], Object.assign(clonePacket(packet), { direction: 'up' }), 'repair_subtree_continue_up');
                    }
                } else {
                    for (const p of rxNode.downPorts) {
                        if (this.portReachesAnyHost(p, packet.intendedReceivers)) {
                            this.enqueuePacket(p, Object.assign(clonePacket(packet), { direction: 'down' }), 'repair_subtree_fanout_down');
                        }
                    }
                }
                return;
            }

            if (rxNode.type === 'SS') {
                for (const p of rxNode.downPorts) {
                    if (p === rxPort) continue;
                    if (this.portReachesAnyHost(p, packet.intendedReceivers)) {
                        this.enqueuePacket(p, Object.assign(clonePacket(packet), { direction: 'down' }), 'repair_subtree_spine_fanout');
                    }
                }
            }
        }

        deliverControlOrRepairUnicast(packet, rxNode) {
            if (packet.kind === 'drop-report' && rxNode.type === 'Host' && rxNode.id === packet.targetHostId) {
                this.handleDropReport(packet, rxNode);
                return;
            }

            if (packet.kind === 'repair-to-switch' && !packet.targetSwitchId && rxNode.type === 'Host' && rxNode.id === packet.targetHostId) {
                this.recordHostDelivery(rxNode, packet);
                return;
            }

            if (packet.kind === 'repair-to-switch' && rxNode.id === packet.targetSwitchId) {
                this.handleRepairAtDroppedSwitch(packet, rxNode);
                return;
            }

            const nextPort = this.nextUnicastPort(rxNode, packet);
            if (!nextPort) {
                this.dropBlock((rxNode.upPorts[0] || rxNode.downPorts[0]), packet, 'unicast_no_route');
                return;
            }
            this.enqueuePacket(nextPort, packet, 'stateless_unicast_forward');
        }

        handleDropReport(packet, host) {
            if (this.acknowledgedReportIds.has(packet.dropReportId)) {
                this.logEvent('drop-report-late-duplicate', {
                    reportId: packet.dropReportId,
                    packetId: packet.id,
                    sourceHost: host.id
                });
                return;
            }
            const report = this.pendingDropReports.find(r => r.id === packet.dropReportId);
            if (report) {
                if (report.receivedTick === null) report.receivedTick = this.currentTick;
                report.lastReceivedTick = this.currentTick;
                report.receivedCount = (report.receivedCount || 0) + 1;
            }

            const originalPacket = this.packetStore[packet.originalPacketId];
            if (!originalPacket) {
                this.unrecoveredPackets++;
                this.logEvent('repair-missing-payload', {
                    reportId: packet.dropReportId,
                    originalPacketId: packet.originalPacketId,
                    sourceHost: host.id
                });
                return;
            }

            const outstandingRepair = (this.repairByReportId[packet.dropReportId] || []).find(r =>
                r.reportId === packet.dropReportId
                && ['pending-source', 'queued', 'at-switch', 'completed'].includes(r.status)
            );
            if (outstandingRepair) {
                this.logEvent('drop-report-duplicate', {
                    reportId: packet.dropReportId,
                    packetId: packet.id,
                    sourceHost: host.id,
                    repairId: outstandingRepair.id
                });
                return;
            }

            if (packet.repairContext && packet.repairContext.droppedSwitchId === host.id) {
                const repair = Object.assign(clonePacket(originalPacket), {
                    id: `repair-local:${packet.dropReportId}:${this.totalRepairsInjected}`,
                    kind: 'repair-subtree',
                    sizeBlocks: this.options.repairPacketBlocks,
                    direction: 'up',
                    intendedReceivers: packet.repairContext.affectedHosts ? packet.repairContext.affectedHosts.slice() : [],
                    originalPacketId: packet.originalPacketId,
                    dropReportId: packet.dropReportId,
                    attempt: packet.attempt,
                    repairContext: Object.assign({}, packet.repairContext)
                });
                this.queueSourceRepair(host, repair, {
                    targetSwitchId: host.id,
                    affectedPortKeys: [host.upPorts[0].key],
                    local: true
                });
                return;
            }

            const repair = this.makeRepairToSwitchPacket(host, packet, originalPacket);
            this.queueSourceRepair(host, repair, {
                targetSwitchId: repair.targetSwitchId,
                affectedPortKeys: repair.affectedPortKeys.slice(),
                local: false
            });
        }

        queueSourceRepair(host, repair, meta) {
            if (this.repairById[repair.id]) return;
            const entry = {
                id: repair.id,
                reportId: repair.dropReportId,
                originalPacketId: repair.originalPacketId,
                sourceHost: host.id,
                targetSwitchId: meta.targetSwitchId,
                affectedHosts: repair.intendedReceivers.slice(),
                affectedPortKeys: meta.affectedPortKeys.slice(),
                deliveredHosts: [],
                attempt: repair.attempt,
                createdTick: this.currentTick,
                queuedTick: null,
                deliveredToSwitchTick: meta.local ? this.currentTick : null,
                completedTick: null,
                local: meta.local,
                status: 'pending-source'
            };
            if (this.options.storageMode !== 'aggregate') this.repairLedger.push(entry);
            this.repairById[entry.id] = entry;
            if (!this.repairByReportId[entry.reportId]) this.repairByReportId[entry.reportId] = [];
            this.repairByReportId[entry.reportId].push(entry);
            this.pendingSourceRepairs.push({ packet: repair, sourceHost: host.id, local: meta.local, status: 'pending' });
            this.logEvent('repair-pending-source', {
                packetId: repair.id,
                reportId: repair.dropReportId,
                sourceHost: host.id,
                originalPacketId: repair.originalPacketId,
                local: meta.local
            });
        }

        releasePendingSourceRepairs() {
            for (const pending of this.pendingSourceRepairs) {
                if (pending.status !== 'pending') continue;
                const host = this.getHostById(pending.sourceHost);
                if (!host || !this.sourceAvailableForRepair(host.id)) continue;
                const packet = pending.packet;
                const nextPort = pending.local ? host.upPorts[0] : this.nextUnicastPort(host, packet);
                if (!nextPort) {
                    pending.status = 'failed';
                    this.unrecoveredPackets++;
                    this.logEvent('repair-no-route', { packetId: packet.id, reportId: packet.dropReportId, originalPacketId: packet.originalPacketId });
                    continue;
                }
                if (!this.enqueuePacket(nextPort, packet, pending.local ? 'local_host_repair' : 'repair_to_switch', { dropOnFull: false })) {
                    pending.waitingForPort = nextPort.key;
                    continue;
                }
                pending.status = 'queued';
                const entry = this.repairById[packet.id];
                if (entry) {
                    entry.status = 'queued';
                    entry.queuedTick = this.currentTick;
                    const report = this.pendingDropReports.find(item => item.id === entry.reportId);
                    if (report && report.repairQueuedTick === undefined) report.repairQueuedTick = this.currentTick;
                }
                this.totalRepairsInjected++;
                this.totalRepairBlocks += packet.sizeBlocks;
                if (pending.local) this.acknowledgeDropReport(packet.dropReportId, host.id);
                this.logEvent(pending.local ? 'repair-inject-local' : 'repair-inject', {
                    packetId: packet.id,
                    reportId: packet.dropReportId,
                    sourceHost: host.id,
                    targetSwitchId: packet.targetSwitchId || host.id,
                    originalPacketId: packet.originalPacketId
                });
            }
        }

        handleRepairAtDroppedSwitch(packet, switchNode) {
            const repairEntry = this.repairById[packet.id];
            if (repairEntry) {
                repairEntry.deliveredToSwitchTick = this.currentTick;
                repairEntry.status = 'at-switch';
                const report = this.pendingDropReports.find(item => item.id === repairEntry.reportId);
                if (report) report.repairSwitchTick = this.currentTick;
            }
            this.acknowledgeDropReport(packet.dropReportId, switchNode.id);

            for (const portKey of packet.affectedPortKeys || []) {
                const port = switchNode.upPorts.concat(switchNode.downPorts).find(p => p.key === portKey);
                if (!port) continue;
                const direction = switchNode.upPorts.includes(port) ? 'up' : 'down';
                const subtreePacket = this.makeRepairSubtreePacket(packet, direction);
                this.enqueuePacket(port, subtreePacket, 'repair_subtree_start');
            }
            this.logEvent('repair-arrive-switch', {
                packetId: packet.id,
                reportId: packet.dropReportId,
                switchId: switchNode.id,
                affectedPortKeys: packet.affectedPortKeys
            });
        }

        acknowledgeDropReport(reportId, switchId) {
            const report = this.pendingDropReports.find(r => r.id === reportId);
            if (!report || report.status === 'acknowledged') return;
            report.status = 'acknowledged';
            this.acknowledgedReportIds.add(reportId);
            report.acknowledgedTick = this.currentTick;
            report.acknowledgedBySwitch = switchId;
            this.logEvent('drop-report-implicit-ack', {
                reportId,
                switchId,
                sendCount: report.sendCount || 0
            });
            if (this.options.storageMode === 'aggregate') {
                this.recoveryLatencySamples.push(this.currentTick - report.firstDropTick);
                this.pendingDropReports = this.pendingDropReports.filter(item => item.id !== report.id);
                delete this.pendingDropReportMap[report.key];
            }
        }

        portReachesAnyHost(port, hostIds) {
            if (!port || !hostIds || hostIds.length === 0) return false;
            const reachable = this.collectHostsBehindPort(port, new Set());
            return hostIds.some(id => reachable.has(id));
        }

        targetsRemainOutsideDownPorts(node, ingressPort, hostIds) {
            const local = new Set();
            for (const p of node.downPorts) {
                if (p === ingressPort) continue;
                const hosts = this.collectHostsBehindPort(p, new Set());
                for (const h of hosts) local.add(h);
            }
            return hostIds.some(id => !local.has(id));
        }

        collectHostsBehindPort(port, visited) {
            const out = new Set();
            if (!port || !port.targetPort) return out;
            const node = port.targetNode;
            const key = `${port.key}->${port.targetPort.key}`;
            if (visited.has(key)) return out;
            visited.add(key);

            if (node.type === 'Host') {
                out.add(node.id);
                return out;
            }

            for (const p of node.downPorts || []) {
                if (p === port.targetPort) continue;
                const childHosts = this.collectHostsBehindPort(p, visited);
                for (const h of childHosts) out.add(h);
            }
            return out;
        }

        deliverUnicast(packet, rxNode) {
            if (rxNode.type === 'Host') {
                if (rxNode.id === packet.targetHostId) {
                    this.recordHostDelivery(rxNode, packet);
                } else {
                    this.dropBlock(rxNode.upPorts[0], packet, 'wrong_unicast_host');
                }
                return;
            }
            const nextPort = this.nextUnicastPort(rxNode, packet);
            if (!nextPort) {
                this.dropBlock((rxNode.upPorts[0] || rxNode.downPorts[0]), packet, 'unicast_no_route');
                return;
            }
            this.enqueuePacket(nextPort, packet, 'stateless_unicast_forward');
        }

        nextUnicastPort(node, packet) {
            if (packet.targetSwitchId) return this.nextPortToSwitch(node, packet.targetSwitchId);
            const target = this.parseHostId(packet.targetHostId);
            if (!target) return null;

            if (node.type === 'Host') return node.upPorts[0];

            if (node.type === 'RS') {
                if (node.meta.pod === target.pod && node.meta.rack === target.rack) {
                    return node.downPorts[target.hostInRack];
                }
                return node.upPorts[packet.unicastRoute ? packet.unicastRoute.rsUpPortIndex : 0];
            }

            if (node.type === 'FS') {
                if (node.meta.pod === target.pod) {
                    return node.downPorts[target.rack];
                }
                return node.upPorts[packet.unicastRoute ? packet.unicastRoute.fsUpPortIndex : 0];
            }

            if (node.type === 'SS') {
                return node.downPorts[target.pod];
            }

            return null;
        }

        nextPortToSwitch(node, targetSwitchId) {
            if (node.id === targetSwitchId) return null;
            const target = this.parseSwitchId(targetSwitchId);
            if (!target) return null;

            if (node.type === 'Host') return node.upPorts[0];

            if (node.type === 'RS') {
                if (target.type === 'RS' && node.meta.pod === target.pod && node.meta.rack === target.rack) return null;
                if (target.type === 'RS' && node.meta.pod === target.pod) return node.upPorts[0];
                if (target.type === 'FS') return node.upPorts[target.pod === node.meta.pod ? target.fabricIndex : target.fabricIndex];
                if (target.type === 'SS') return node.upPorts[target.spineIndex < 2 ? 0 : 1];
                return node.upPorts[0];
            }

            if (node.type === 'FS') {
                if (target.type === 'FS') {
                    if (node.meta.pod === target.pod && node.meta.fabricIndex === target.fabricIndex) return null;
                    if (node.meta.fabricIndex === target.fabricIndex && node.meta.pod !== target.pod) return node.upPorts[0];
                    return node.downPorts[0];
                }
                if (target.type === 'RS') {
                    if (node.meta.pod === target.pod) return node.downPorts[target.rack];
                    return node.upPorts[0];
                }
                if (target.type === 'SS') {
                    const groupMatches = (node.meta.fabricIndex === 0 && target.spineIndex < 2) || (node.meta.fabricIndex === 1 && target.spineIndex >= 2);
                    if (groupMatches) return node.upPorts[target.spineIndex % 2];
                    return node.downPorts[0];
                }
                return node.upPorts[0];
            }

            if (node.type === 'SS') {
                if (target.type === 'SS') return node.downPorts[0];
                return node.downPorts[target.pod];
            }

            return null;
        }

        parseHostId(hostId) {
            const match = /^H_(\d+)_(\d+)$/.exec(hostId);
            if (!match) return null;
            const pod = Number(match[1]);
            const hostIndexInPod = Number(match[2]);
            return {
                pod,
                hostIndexInPod,
                rack: hostIndexInPod < 2 ? 0 : 1,
                hostInRack: hostIndexInPod % 2
            };
        }

        parseSwitchId(switchId) {
            let match = /^SS(\d+)$/.exec(switchId);
            if (match) return { type: 'SS', spineIndex: Number(match[1]), pod: null };
            match = /^FS_(\d+)_(\d+)$/.exec(switchId);
            if (match) return { type: 'FS', pod: Number(match[1]), fabricIndex: Number(match[2]) };
            match = /^RS_(\d+)_(\d+)$/.exec(switchId);
            if (match) return { type: 'RS', pod: Number(match[1]), rack: Number(match[2]) };
            return null;
        }

        recordHostDelivery(host, packet) {
            const sourceKey = packet.sourceId;
            const seqKey = packet.originalPacketId || packet.id;
            if (!host.receivedSeqs[sourceKey]) host.receivedSeqs[sourceKey] = {};
            if (host.receivedSeqs[sourceKey][seqKey]) {
                this.logEvent('duplicate-delivery', { packetId: packet.id, hostId: host.id, sourceId: sourceKey });
                return;
            }
            host.receivedSeqs[sourceKey][seqKey] = true;
            host.completed++;
            host.receivedStats[sourceKey] = (host.receivedStats[sourceKey] || 0) + 1;
            this.totalDelivered++;
            if (host.receivedStats[sourceKey] === this.hostPayloadSize) {
                host.fctStats[sourceKey] = this.currentTick;
            }
            if (packet.kind === 'repair-subtree' || (packet.kind === 'repair-to-switch' && packet.originalPacketId)) {
                const repairEntry = packet.repairId
                    ? this.repairById[packet.repairId]
                    : (this.repairByReportId[packet.dropReportId] || []).slice().reverse().find(r =>
                        r.reportId === packet.dropReportId && r.status !== 'dropped-to-switch'
                    );
                if (repairEntry) {
                    if (!repairEntry.deliveredHosts) repairEntry.deliveredHosts = [];
                    if (!repairEntry.deliveredHosts.includes(host.id)) repairEntry.deliveredHosts.push(host.id);
                    if (repairEntry.deliveredHosts.length >= repairEntry.affectedHosts.length) {
                        repairEntry.completedTick = this.currentTick;
                        repairEntry.status = 'completed';
                        this.lastRepairCompletedTick = Math.max(this.lastRepairCompletedTick, this.currentTick);
                        const report = this.pendingDropReports.find(item => item.id === repairEntry.reportId);
                        if (report) report.repairCompletedTick = this.currentTick;
                        if (this.options.storageMode === 'aggregate') this.retireRepair(repairEntry);
                    }
                }
            }
            this.logEvent('deliver', {
                packetId: packet.id,
                kind: packet.kind,
                hostId: host.id,
                sourceId: sourceKey,
                collectiveId: packet.collectiveId,
                seqNo: packet.seqNo
            });
        }

        retireRepair(repairEntry) {
            if (!repairEntry) return;
            delete this.repairById[repairEntry.id];
            const list = this.repairByReportId[repairEntry.reportId] || [];
            this.repairByReportId[repairEntry.reportId] = list.filter(item => item.id !== repairEntry.id);
        }

        dropBlock(port, packet, reason) {
            this.totalDrops++;
            const affectedHosts = this.predictAffectedHosts(port, packet);
            const entry = {
                id: `drop-${this.totalDrops}`,
                tick: this.currentTick,
                reason,
                switchId: port && port.sourceNode ? port.sourceNode.id : 'unknown',
                switchType: port && port.sourceNode ? port.sourceNode.type : 'unknown',
                portId: port ? port.id : 'unknown',
                portKey: port && port.key ? port.key : 'unknown',
                direction: packet.direction,
                packetId: packet.id,
                packetKind: packet.kind,
                collectiveId: packet.collectiveId,
                caId: packet.caId,
                colorIndex: packet.colorIndex,
                sourceHost: packet.sourceId,
                seqNo: packet.seqNo,
                targetHostId: packet.targetHostId,
                affectedHosts,
                affectedCount: affectedHosts.length,
                queueDepth: port && port.queue ? port.queue.length : 0,
                queueBlocks: port && port.queue ? this.queueOccupancy(port) : 0,
                packetSizeBlocks: this.packetSize(packet),
                capacity: this.capacity,
                bufferLimit: this.bufferLimit,
                originalPacketId: packet.originalPacketId || packet.id,
                attempt: packet.attempt || 0,
                pendingReportId: null
            };
            this.dropByInterfaceCounters[entry.portKey] = (this.dropByInterfaceCounters[entry.portKey] || 0) + 1;
            this.dropByCollectiveCounters[entry.collectiveId] = (this.dropByCollectiveCounters[entry.collectiveId] || 0) + 1;
            this.dropByLayerCounters[entry.switchType] = (this.dropByLayerCounters[entry.switchType] || 0) + 1;
            this.dropByKindCounters[entry.packetKind] = (this.dropByKindCounters[entry.packetKind] || 0) + 1;
            if (this.options.storageMode !== 'aggregate') {
                this.dropLedger.push(entry);
                this.dropById[entry.id] = entry;
            }
            if (packet.kind === 'repair-to-switch') {
                const repairEntry = this.repairById[packet.id];
                if (repairEntry) {
                    repairEntry.status = 'dropped-to-switch';
                    repairEntry.droppedTick = this.currentTick;
                    repairEntry.droppedPortKey = entry.portKey;
                    if (this.options.storageMode === 'aggregate') this.retireRepair(repairEntry);
                }
            }
            this.addPendingDropReport(entry, port, packet);
            if (this.options.storageMode !== 'aggregate') {
                const pt = port && port.getCenter ? port.getCenter() : { x: 0, y: 0 };
                this.dropEvents.push({
                    x: pt.x + (this.rng() - 0.5) * 8,
                    y: pt.y + (this.rng() - 0.5) * 8,
                    colorIndex: packet.colorIndex,
                    age: 0,
                    dropId: entry.id
                });
            }
            this.logEvent('drop', entry);
        }

        predictAffectedHosts(port, packet) {
            if (packet.kind === 'drop-report') return packet.targetHostId ? [packet.targetHostId] : [];
            if (packet.kind === 'repair-to-switch') return packet.intendedReceivers ? packet.intendedReceivers.slice() : [];
            if (packet.kind === 'repair-subtree') return this.predictRepairAffectedHosts(port, packet);
            if (!port || !port.targetPort) return packet.intendedReceivers ? packet.intendedReceivers.slice() : [];
            const receivers = this.predictReceiversAfterTraversal(packet, port.targetPort, new Set(), new Set());
            return receivers.filter(id => id !== packet.sourceId).sort();
        }

        predictRepairAffectedHosts(port, packet) {
            if (!packet.intendedReceivers) return [];
            if (!port || !port.targetPort) return packet.intendedReceivers.slice();
            const reachable = new Set(
                this.predictReceiversAfterTraversal(packet, port.targetPort, new Set(), new Set())
            );
            return packet.intendedReceivers.filter(id => reachable.has(id)).sort();
        }

        predictReceiversAfterTraversal(packet, rxPort, visited, out) {
            const rxNode = rxPort.sourceNode;
            const visitKey = `${packet.id}:${rxNode.id}:${rxPort.id}:${packet.direction}`;
            if (visited.has(visitKey)) return Array.from(out);
            visited.add(visitKey);

            if (rxNode.type === 'Host') {
                if (rxNode.colorIndex === packet.colorIndex && rxNode.id !== packet.sourceId) out.add(rxNode.id);
                return Array.from(out);
            }

            if (rxNode.type === 'RS' || rxNode.type === 'FS') {
                if (packet.direction === 'up') {
                    for (const p of rxNode.downPorts) {
                        if (p === rxPort) continue;
                        if (p.reachableCounts && p.reachableCounts[packet.colorIndex] > 0) {
                            this.predictReceiversAfterTraversal(Object.assign(clonePacket(packet), { direction: 'down' }), p.targetPort, visited, out);
                        }
                    }
                    if (rxNode.needsUp && rxNode.needsUp[packet.colorIndex]) {
                        const pIdx = rxNode.type === 'RS'
                            ? this.collectives[packet.colorIndex].rsUpPortIndex
                            : this.collectives[packet.colorIndex].fsUpPortIndex;
                        const upPort = rxNode.upPorts[pIdx];
                        if (upPort && upPort.targetPort) this.predictReceiversAfterTraversal(Object.assign(clonePacket(packet), { direction: 'up' }), upPort.targetPort, visited, out);
                    }
                } else {
                    for (const p of rxNode.downPorts) {
                        if (p.reachableCounts && p.reachableCounts[packet.colorIndex] > 0) {
                            this.predictReceiversAfterTraversal(Object.assign(clonePacket(packet), { direction: 'down' }), p.targetPort, visited, out);
                        }
                    }
                }
                return Array.from(out);
            }

            if (rxNode.type === 'SS') {
                for (const p of rxNode.downPorts) {
                    if (p === rxPort) continue;
                    if (p.reachableCounts && p.reachableCounts[packet.colorIndex] > 0) {
                        this.predictReceiversAfterTraversal(Object.assign(clonePacket(packet), { direction: 'down' }), p.targetPort, visited, out);
                    }
                }
            }
            return Array.from(out);
        }

        getNodeById(id) {
            return this.allNodes.find(n => n.id === id) || null;
        }

        getHostById(id) {
            return this.hosts.find(h => h.id === id) || null;
        }

        sourceAvailableForRepair(sourceHostId) {
            const host = this.getHostById(sourceHostId);
            return !!host && host.pending === 0 && !host.active;
        }

        addPendingDropReport(dropEntry, port, packet) {
            if (!this.options.enableRecovery) return;
            if (!dropEntry.affectedHosts || dropEntry.affectedHosts.length === 0) return;
            if (packet.kind === 'drop-report' || packet.kind === 'repair-to-switch'
                || packet.kind === 'congestion-report' || packet.kind === 'rate-update') return;
            const attempt = (packet.attempt || 0) + (packet.kind === 'data-multicast' ? 0 : 1);
            if (Number.isFinite(this.options.maxRepairAttempts) && attempt > this.options.maxRepairAttempts) {
                this.unrecoveredPackets++;
                dropEntry.unrecovered = true;
                dropEntry.unrecoveredReason = 'max_repair_attempts';
                return;
            }

            const originalPacketId = packet.originalPacketId || packet.id;
            const affectedPortKeys = [dropEntry.portKey];
            const key = [
                dropEntry.sourceHost,
                originalPacketId,
                dropEntry.switchId,
                affectedPortKeys.join('|'),
                attempt
            ].join('::');

            let report = this.pendingDropReportMap[key];
            if (!report) {
                report = {
                    id: `report-${++this.reportSequence}`,
                    key,
                    status: 'pending',
                    createdTick: this.currentTick,
                    sentTick: null,
                    receivedTick: null,
                    lastSentTick: null,
                    lastReceivedTick: null,
                    acknowledgedTick: null,
                    acknowledgedBySwitch: null,
                    sendCount: 0,
                    receivedCount: 0,
                    nextRetryTick: null,
                    firstDropTick: dropEntry.tick,
                    sourceHost: dropEntry.sourceHost,
                    originalPacketId,
                    packetId: dropEntry.packetId,
                    seqNo: dropEntry.seqNo,
                    colorIndex: dropEntry.colorIndex,
                    collectiveId: dropEntry.collectiveId,
                    caId: dropEntry.caId,
                    droppedSwitchId: dropEntry.switchId,
                    droppedPortKey: dropEntry.portKey,
                    affectedPortKeys,
                    affectedHosts: [],
                    dropIds: [],
                    attempt,
                    localSelfReport: dropEntry.switchId === dropEntry.sourceHost
                };
                this.pendingDropReportMap[key] = report;
                this.pendingDropReports.push(report);
            }

            for (const h of dropEntry.affectedHosts) {
                if (!report.affectedHosts.includes(h)) report.affectedHosts.push(h);
            }
            if (!report.dropIds.includes(dropEntry.id)) report.dropIds.push(dropEntry.id);
            report.firstDropTick = Math.min(report.firstDropTick, dropEntry.tick);
            dropEntry.pendingReportId = report.id;
        }

        releasePendingDropReports() {
            for (const report of this.pendingDropReports) {
                const firstSend = report.status === 'pending';
                const retryDue = report.status === 'awaiting-repair'
                    && report.nextRetryTick !== null
                    && this.currentTick >= report.nextRetryTick;
                if (!firstSend && !retryDue) continue;
                if (!this.sourceAvailableForRepair(report.sourceHost)) continue;

                if (report.localSelfReport) {
                    const packet = this.makeDropReportPacket(report);
                    report.status = 'awaiting-repair';
                    if (report.sentTick === null) report.sentTick = this.currentTick;
                    report.lastSentTick = this.currentTick;
                    if (report.receivedTick === null) report.receivedTick = this.currentTick;
                    report.lastReceivedTick = this.currentTick;
                    report.sendCount++;
                    report.receivedCount++;
                    this.totalControlReports++;
                    if (this.options.storageMode !== 'aggregate') {
                        this.controlLedger.push(Object.assign({}, report, { transport: 'local-self-report' }));
                    }
                    this.handleDropReport(packet, this.getHostById(report.sourceHost));
                    this.logEvent('drop-report-local', { reportId: report.id, sourceHost: report.sourceHost });
                    continue;
                }

                const sourceNode = this.getNodeById(report.droppedSwitchId);
                if (!sourceNode) continue;
                const packet = this.makeDropReportPacket(report);
                const nextPort = this.nextUnicastPort(sourceNode, packet);
                if (!nextPort) continue;
                if (!this.enqueuePacket(nextPort, packet, 'deferred_drop_report', { dropOnFull: false })) {
                    report.waitingForPort = nextPort.key;
                    continue;
                }
                report.status = 'awaiting-repair';
                if (report.sentTick === null) report.sentTick = this.currentTick;
                report.lastSentTick = this.currentTick;
                report.sendCount++;
                const backoff = Math.min(
                    this.options.dropReportRetryMaxTicks,
                    this.options.dropReportRetryBaseTicks * Math.pow(2, Math.min(8, report.sendCount - 1))
                );
                report.nextRetryTick = this.currentTick + backoff;
                report.waitingForPort = null;
                this.totalControlReports++;
                this.totalControlBlocks += packet.sizeBlocks;
                if (this.options.storageMode !== 'aggregate') {
                    this.controlLedger.push(Object.assign({}, report, { transport: 'network', packetId: packet.id }));
                }
                this.logEvent('drop-report-send', {
                    reportId: report.id,
                    packetId: packet.id,
                    sourceNodeId: report.droppedSwitchId,
                    targetHostId: report.sourceHost,
                    originalPacketId: report.originalPacketId
                });
            }
        }

        hasQueuedData() {
            if (this.inflight.length > 0) return true;
            if (this.pendingDropReports.some(r => r.status === 'pending' || r.status === 'awaiting-repair')) return true;
            if (this.pendingSourceRepairs.some(r => r.status === 'pending')) return true;
            if (this.pendingFeedbackUpdates.some(item => item.status !== 'released')) return true;
            if (this.pendingLosslessForwards.length > 0) return true;
            for (const n of this.allNodes) {
                for (const p of n.upPorts.concat(n.downPorts)) {
                    if (p.queue.length > 0) return true;
                }
            }
            return false;
        }

        hasActiveDataInNetwork() {
            if (this.isSequentialMode) return true;
            if (this.hasQueuedData()) return true;
            for (const h of this.hosts) {
                if (h.pending > 0 || h.active) return true;
            }
            return false;
        }

        recordTickUtilization() {
            const links = {};
            for (const l of this.allLinks) {
                const blocks = Math.max(l.a.lastTraversed || 0, l.b.lastTraversed || 0);
                if (blocks > 0) {
                    const item = {
                        blocks,
                        pct: Math.round((blocks / this.capacity) * 100),
                        a: l.a.key,
                        b: l.b.key
                    };
                    links[l.id] = item;
                    if (!this.hotLinkCounters[l.id]) {
                        this.hotLinkCounters[l.id] = { maxPct: 0, maxBlocks: 0, hotTicks: 0, a: item.a, b: item.b };
                    }
                    const aggregate = this.hotLinkCounters[l.id];
                    aggregate.maxPct = Math.max(aggregate.maxPct, item.pct);
                    aggregate.maxBlocks = Math.max(aggregate.maxBlocks, item.blocks);
                    if (item.pct >= 100) aggregate.hotTicks++;
                }
            }
            if (this.options.storageMode !== 'aggregate') {
                this.linkUtilizationByTick.push({ tick: this.currentTick, links });
            }
        }

        logEvent(type, fields) {
            if (!this.options.enableEventLog) return;
            if (this.eventLog.length >= this.options.maxEventLogEntries) return;
            this.eventLog.push(Object.assign({
                eventId: ++this.eventId,
                tick: this.currentTick,
                type
            }, fields || {}));
        }

        buildReport(name) {
            const hostStats = this.hosts.map(h => {
                const siblings = h.colorIndex === null ? [] : this.hosts.filter(o => o.colorIndex === h.colorIndex && o.id !== h.id);
                const breakdown = siblings.map(sib => {
                    const received = h.receivedStats[sib.id] || 0;
                    const fct = h.fctStats[sib.id] || null;
                    return {
                        sourceHost: sib.id,
                        received,
                        expected: this.hostPayloadSize,
                        complete: received >= this.hostPayloadSize,
                        fctTicks: fct
                    };
                });
                const complete = breakdown.every(item => item.complete);
                const cctTicks = complete && breakdown.length
                    ? Math.max.apply(null, breakdown.map(item => item.fctTicks || 0))
                    : null;
                return {
                    hostId: h.id,
                    colorIndex: h.colorIndex,
                    collectiveId: h.colorIndex === null ? null : this.collectives[h.colorIndex].id,
                    startOffsetTicks: h.startOffsetTicks || 0,
                    activationTick: h.activationTick,
                    originalTxCompleteTick: h.originalTxCompleteTick,
                    waitingOffsetTicks: h.colorIndex === null ? 0 : (h.startOffsetTicks || 0),
                    configuredRate: h.configuredRate,
                    txRemaining: h.pending,
                    rxTotal: h.completed,
                    complete,
                    cctTicks,
                    breakdown
                };
            });

            const dropsByInterface = Object.assign({}, this.dropByInterfaceCounters);
            const dropsByCollective = Object.assign({}, this.dropByCollectiveCounters);
            const dropsByLayer = Object.assign({}, this.dropByLayerCounters);
            const dropsByKind = Object.assign({}, this.dropByKindCounters);

            const hotLinks = Object.assign({}, this.hotLinkCounters);

            const collectives = this.collectives.map(c => {
                const members = this.hosts.filter(h => h.colorIndex === c.colorIndex);
                const relevantHosts = hostStats.filter(h => h.colorIndex === c.colorIndex);
                const complete = relevantHosts.every(h => h.complete);
                const cctTicks = complete && relevantHosts.length
                    ? Math.max.apply(null, relevantHosts.map(h => h.cctTicks || 0))
                    : null;
                const originalTxCompleteTick = relevantHosts.length
                    ? Math.max.apply(null, relevantHosts.map(h => h.originalTxCompleteTick || 0))
                    : null;
                return {
                    collectiveId: c.id,
                    caId: c.caId,
                    rootId: c.rootId,
                    memberHosts: members.map(h => h.id),
                    complete,
                    cctTicks,
                    originalTxCompleteTick,
                    postTxCompletionTailTicks: complete && originalTxCompleteTick !== null
                        ? Math.max(0, cctTicks - originalTxCompleteTick)
                        : null,
                    recoveryTailTicks: complete && originalTxCompleteTick !== null && (dropsByCollective[c.id] || 0) > 0
                        ? Math.max(0, cctTicks - originalTxCompleteTick)
                        : 0
                };
            });

            const recoveryLatencies = this.pendingDropReports.map(report => {
                const firstDropTick = report.firstDropTick === undefined ? report.createdTick : report.firstDropTick;
                const repairs = this.repairByReportId[report.id] || [];
                const repair = repairs.slice().reverse().find(r => r.completedTick !== null)
                    || repairs[repairs.length - 1]
                    || null;
                return {
                    reportId: report.id,
                    originalPacketId: report.originalPacketId,
                    firstDropTick,
                    reportSentTick: report.sentTick,
                    reportReceivedTick: report.receivedTick,
                    reportLastSentTick: report.lastSentTick,
                    reportAcknowledgedTick: report.acknowledgedTick,
                    reportSendCount: report.sendCount || 0,
                    repairQueuedTick: repair ? repair.queuedTick : (report.repairQueuedTick || null),
                    repairSwitchTick: repair ? repair.deliveredToSwitchTick : (report.repairSwitchTick || null),
                    repairCompletedTick: repair ? repair.completedTick : (report.repairCompletedTick || null),
                    dropToReportTicks: report.sentTick === null ? null : report.sentTick - firstDropTick,
                    reportToRepairCompleteTicks: (repair && repair.completedTick !== null) || report.repairCompletedTick
                        ? (repair ? repair.completedTick : report.repairCompletedTick) - report.sentTick
                        : null,
                    totalRecoveryTicks: (repair && repair.completedTick !== null) || report.repairCompletedTick
                        ? (repair ? repair.completedTick : report.repairCompletedTick) - firstDropTick
                        : null
                };
            });

            return {
                schemaVersion: 'research-sim-v1',
                scenarioName: name || this.runName,
                assumptions: this.assumptionRegister(),
                config: {
                    capacity: this.capacity,
                    bufferLimit: this.bufferLimit,
                    tenantRates: this.tenantRates.slice(),
                    hostPayloadSize: this.hostPayloadSize,
                    seed: this.options.seed,
                    enableRecovery: this.options.enableRecovery,
                    controlPacketBlocks: this.options.controlPacketBlocks,
                    dataPacketBlocks: this.options.dataPacketBlocks,
                    repairPacketBlocks: this.options.repairPacketBlocks,
                    maxRepairAttempts: this.options.maxRepairAttempts,
                    dropReportRetryBaseTicks: this.options.dropReportRetryBaseTicks,
                    dropReportRetryMaxTicks: this.options.dropReportRetryMaxTicks,
                    hostStartOffsets: this.hosts.reduce((acc, h) => {
                        if (h.colorIndex !== null && (h.startOffsetTicks || 0) > 0) acc[h.id] = h.startOffsetTicks || 0;
                        return acc;
                    }, {}),
                    hostRateOverrides: Object.assign({}, this.hostRateOverrides),
                    adaptiveRateControl: this.adaptiveRateControl ? {
                        enabled: true,
                        baseRates: this.adaptiveRateControl.baseRates.slice(),
                        initialMultiplier: this.adaptiveRateControl.initialMultiplier,
                        minMultiplier: this.adaptiveRateControl.minMultiplier,
                        maxMultiplier: this.adaptiveRateControl.maxMultiplier,
                        decreaseFactor: this.adaptiveRateControl.decreaseFactor,
                        increaseStep: this.adaptiveRateControl.increaseStep,
                        increaseEveryTicks: this.adaptiveRateControl.increaseEveryTicks,
                        queueHighWatermark: this.adaptiveRateControl.queueHighWatermark
                    } : null,
                    adaptiveFeedback: this.adaptiveFeedback ? {
                        enabled: true,
                        processingDelayTicks: this.adaptiveFeedback.processingDelayTicks,
                        highWatermark: this.adaptiveFeedback.highWatermark,
                        lowWatermark: this.adaptiveFeedback.lowWatermark,
                        coalesceTicks: this.adaptiveFeedback.coalesceTicks,
                        initialMultiplier: this.adaptiveFeedback.initialMultiplier
                    } : null,
                    storageMode: this.options.storageMode,
                    losslessAdmissionControl: this.losslessAdmissionControl
                },
                summary: {
                    ticks: this.currentTick,
                    totalInjected: this.totalInjected,
                    totalDataBlocks: this.totalInjected * this.options.dataPacketBlocks,
                    totalRepairsInjected: this.totalRepairsInjected,
                    totalControlReports: this.totalControlReports,
                    totalControlBlocks: this.totalControlBlocks,
                    totalFeedbackReports: this.totalFeedbackReports,
                    totalRateUpdates: this.totalRateUpdates,
                    totalAdaptiveControlBlocks: this.totalAdaptiveControlBlocks,
                    totalRepairBlocks: this.totalRepairBlocks,
                    totalDelivered: this.totalDelivered,
                    totalDrops: this.totalDrops,
                    dropsPerOriginalBlock: this.totalInjected ? this.totalDrops / this.totalInjected : 0,
                    repairsPerOriginalBlock: this.totalInjected ? this.totalRepairsInjected / this.totalInjected : 0,
                    originalTxCompleteTick: hostStats.filter(h => h.colorIndex !== null).reduce(
                        (maxTick, h) => Math.max(maxTick, h.originalTxCompleteTick || 0),
                        0
                    ),
                    recoveryTailTicks: collectives.filter(c => c.memberHosts.length > 0 && c.complete).reduce(
                        (maxTail, c) => Math.max(maxTail, c.recoveryTailTicks || 0),
                        0
                    ),
                    postTxCompletionTailTicks: collectives.filter(c => c.memberHosts.length > 0 && c.complete).reduce(
                        (maxTail, c) => Math.max(maxTail, c.postTxCompletionTailTicks || 0),
                        0
                    ),
                    lastRepairCompletedTick: this.lastRepairCompletedTick,
                    totalWaitingOffsetTicks: this.hosts.reduce((sum, h) => sum + (h.colorIndex === null ? 0 : (h.startOffsetTicks || 0)), 0),
                    pendingDropReports: this.pendingDropReports.filter(r => r.status !== 'acknowledged').length,
                    retransmittedDropReports: this.pendingDropReports.reduce(
                        (sum, r) => sum + Math.max(0, (r.sendCount || 0) - 1),
                        0
                    ),
                    pendingSourceRepairs: this.pendingSourceRepairs.filter(r => r.status === 'pending').length,
                    pendingLosslessForwards: this.pendingLosslessForwards.length,
                    unrecoveredPackets: this.unrecoveredPackets,
                    activeAtEnd: this.hasActiveDataInNetwork(),
                    timeoutReason: this.runtimeTimeoutReason,
                    wallClockLimitMs: this.runtimeWallClockLimitMs,
                    wallClockElapsedMs: this.runtimeStartedAtMs === null ? null : Date.now() - this.runtimeStartedAtMs
                },
                collectives,
                hostStats,
                dropsByInterface,
                dropsByCollective,
                dropsByLayer,
                dropsByKind,
                hotLinks,
                recoveryLatencies,
                recoveryLatencySummary: {
                    count: this.recoveryLatencySamples.length || recoveryLatencies.length,
                    p50RecoveryTicks: percentile(
                        this.recoveryLatencySamples.length
                            ? this.recoveryLatencySamples
                            : recoveryLatencies.map(item => item.totalRecoveryTicks),
                        50
                    ),
                    p95RecoveryTicks: percentile(
                        this.recoveryLatencySamples.length
                            ? this.recoveryLatencySamples
                            : recoveryLatencies.map(item => item.totalRecoveryTicks),
                        95
                    )
                },
                controlLedger: this.controlLedger.slice(),
                repairLedger: this.repairLedger.slice(),
                rateAdvisor: this.buildRateAdvisor(),
                spineHeatmapAdvisor: this.buildSpineHeatmapAdvisor(),
                adaptiveRateHistory: this.adaptiveRateHistory.slice(),
                feedbackLedger: this.feedbackLedger.slice(),
                dropLedger: this.dropLedger.slice(),
                eventLog: this.eventLog.slice(),
                linkUtilizationByTick: this.linkUtilizationByTick.slice()
            };
        }

        buildRateAdvisor() {
            const perCollective = [];
            const combinedLinkLoad = {};
            const perSourceLinkLoad = {};
            const effectiveLosslessCapacity = Math.min(this.capacity, this.bufferLimit);

            for (const collective of this.collectives) {
                const members = this.hosts.filter(h => h.colorIndex === collective.colorIndex);
                if (members.length === 0) {
                    perCollective.push({
                        collectiveId: collective.id,
                        members: 0,
                        maxLoadFactor: 0,
                        recommendedLosslessRate: 0,
                        bottleneckLinks: []
                    });
                    continue;
                }

                const load = {};
                for (const h of members) {
                    const packet = this.makeAdvisorPacket(h, collective);
                    const sourceLoad = {};
                    this.tracePacketLoadFromPort(h.upPorts[0], packet, sourceLoad, new Set());
                    perSourceLinkLoad[h.id] = sourceLoad;
                    for (const linkId in sourceLoad) load[linkId] = (load[linkId] || 0) + sourceLoad[linkId];
                }

                for (const linkId in load) combinedLinkLoad[linkId] = (combinedLinkLoad[linkId] || 0) + load[linkId];
                const maxLoadFactor = Object.values(load).reduce((m, v) => Math.max(m, v), 0);
                const rawLosslessRate = maxLoadFactor > 0 ? effectiveLosslessCapacity / maxLoadFactor : effectiveLosslessCapacity;
                const burstSafeRate = maxLoadFactor > 0 ? Math.floor(this.bufferLimit / maxLoadFactor) : this.bufferLimit;
                const recommendedLosslessRate = burstSafeRate >= 1
                    ? Math.min(rawLosslessRate, burstSafeRate)
                    : rawLosslessRate;
                const recommendedIntegerRate = maxLoadFactor > 0 ? Math.floor(effectiveLosslessCapacity / maxLoadFactor) : effectiveLosslessCapacity;
                const bottleneckLinks = Object.keys(load)
                    .filter(linkId => load[linkId] === maxLoadFactor)
                    .map(linkId => ({ linkId, loadFactor: load[linkId] }));

                perCollective.push({
                    collectiveId: collective.id,
                    caId: collective.caId,
                    rootId: collective.rootId,
                    members: members.length,
                    maxLoadFactor,
                    recommendedLosslessRate,
                    recommendedIntegerRate,
                    bottleneckLinks
                });
            }

            const combinedMaxLoadFactor = Object.values(combinedLinkLoad).reduce((m, v) => Math.max(m, v), 0);
            const rawCombinedRate = combinedMaxLoadFactor > 0 ? effectiveLosslessCapacity / combinedMaxLoadFactor : effectiveLosslessCapacity;
            const combinedBurstSafeRate = combinedMaxLoadFactor > 0 ? Math.floor(this.bufferLimit / combinedMaxLoadFactor) : this.bufferLimit;
            const combinedRecommendedUniformRate = combinedBurstSafeRate >= 1
                ? Math.min(rawCombinedRate, combinedBurstSafeRate)
                : rawCombinedRate;
            const perSourceRecommendedRates = this.maxMinSourceRates(perSourceLinkLoad);
            for (const sourceId of Object.keys(perSourceRecommendedRates)) {
                if (combinedBurstSafeRate >= 1) {
                    perSourceRecommendedRates[sourceId] = Math.min(perSourceRecommendedRates[sourceId], combinedBurstSafeRate);
                }
            }
            return {
                method: 'one-block-per-active-source-link-load',
                effectiveLosslessCapacity,
                perCollective,
                combinedMaxLoadFactor,
                combinedRecommendedUniformRate,
                combinedRecommendedIntegerRate: combinedMaxLoadFactor > 0 ? Math.floor(effectiveLosslessCapacity / combinedMaxLoadFactor) : effectiveLosslessCapacity,
                perSourceRecommendedRates,
                perSourceMethod: 'max-min-progressive-filling'
            };
        }

        maxMinSourceRates(perSourceLinkLoad) {
            const sourceIds = Object.keys(perSourceLinkLoad);
            const rates = {};
            const active = new Set(sourceIds);
            const links = new Set();
            for (const sourceId of sourceIds) {
                rates[sourceId] = 0;
                for (const linkId of Object.keys(perSourceLinkLoad[sourceId])) links.add(linkId);
            }
            const residual = {};
            const effectiveLosslessCapacity = Math.min(this.capacity, this.bufferLimit);
            for (const linkId of links) residual[linkId] = effectiveLosslessCapacity;

            while (active.size > 0) {
                let delta = Number.POSITIVE_INFINITY;
                for (const linkId of links) {
                    let activeCoefficient = 0;
                    for (const sourceId of active) {
                        activeCoefficient += perSourceLinkLoad[sourceId][linkId] || 0;
                    }
                    if (activeCoefficient > 0) {
                        delta = Math.min(delta, residual[linkId] / activeCoefficient);
                    }
                }
                if (!Number.isFinite(delta) || delta <= 1e-12) break;

                for (const sourceId of active) rates[sourceId] += delta;
                const saturatedLinks = new Set();
                for (const linkId of links) {
                    let activeCoefficient = 0;
                    for (const sourceId of active) {
                        activeCoefficient += perSourceLinkLoad[sourceId][linkId] || 0;
                    }
                    residual[linkId] = Math.max(0, residual[linkId] - delta * activeCoefficient);
                    if (activeCoefficient > 0 && residual[linkId] <= 1e-9) saturatedLinks.add(linkId);
                }

                const frozen = [];
                for (const sourceId of active) {
                    if (Array.from(saturatedLinks).some(linkId => (perSourceLinkLoad[sourceId][linkId] || 0) > 0)) {
                        frozen.push(sourceId);
                    }
                }
                if (!frozen.length) break;
                for (const sourceId of frozen) active.delete(sourceId);
            }
            return rates;
        }

        makeAdvisorPacket(host, collective) {
            return {
                id: `advisor:${collective.id}:${host.id}`,
                kind: 'data-multicast',
                sizeBlocks: this.options.dataPacketBlocks,
                colorIndex: collective.colorIndex,
                collectiveId: collective.id,
                caId: collective.caId,
                sourceId: host.id,
                seqNo: 0,
                direction: 'up',
                createdTick: this.currentTick,
                intendedReceivers: this.hosts.filter(h => h.colorIndex === collective.colorIndex && h.id !== host.id).map(h => h.id),
                targetHostId: null,
                targetSwitchId: null,
                originalPacketId: null,
                unicastRoute: null
            };
        }

        tracePacketLoadFromPort(port, packet, load, visited) {
            if (!port || !port.targetPort) return;
            const key = `${port.key}->${port.targetPort.key}:${packet.direction}:${packet.id}`;
            if (visited.has(key)) return;
            visited.add(key);
            const linkId = `${port.key}<->${port.targetPort.key}`;
            load[linkId] = (load[linkId] || 0) + this.packetSize(packet);
            const rxNode = port.targetNode;
            const rxPort = port.targetPort;

            if (rxNode.type === 'Host') return;

            if (rxNode.type === 'RS' || rxNode.type === 'FS') {
                if (packet.direction === 'up') {
                    for (const p of rxNode.downPorts) {
                        if (p === rxPort) continue;
                        if (p.reachableCounts && p.reachableCounts[packet.colorIndex] > 0) {
                            this.tracePacketLoadFromPort(p, Object.assign(clonePacket(packet), { direction: 'down' }), load, visited);
                        }
                    }
                    if (rxNode.needsUp && rxNode.needsUp[packet.colorIndex]) {
                        const pIdx = rxNode.type === 'RS'
                            ? this.collectives[packet.colorIndex].rsUpPortIndex
                            : this.collectives[packet.colorIndex].fsUpPortIndex;
                        this.tracePacketLoadFromPort(rxNode.upPorts[pIdx], Object.assign(clonePacket(packet), { direction: 'up' }), load, visited);
                    }
                } else {
                    for (const p of rxNode.downPorts) {
                        if (p.reachableCounts && p.reachableCounts[packet.colorIndex] > 0) {
                            this.tracePacketLoadFromPort(p, Object.assign(clonePacket(packet), { direction: 'down' }), load, visited);
                        }
                    }
                }
                return;
            }

            if (rxNode.type === 'SS') {
                for (const p of rxNode.downPorts) {
                    if (p === rxPort) continue;
                    if (p.reachableCounts && p.reachableCounts[packet.colorIndex] > 0) {
                        this.tracePacketLoadFromPort(p, Object.assign(clonePacket(packet), { direction: 'down' }), load, visited);
                    }
                }
            }
        }

        buildSpineHeatmapAdvisor() {
            const bySpine = {};
            for (const ss of this.cores) bySpine[ss.id] = { estimatedBlocks: 0, collectives: {} };

            const rateAdvisor = this.buildRateAdvisor();
            for (const item of rateAdvisor.perCollective) {
                if (!item.rootId || !bySpine[item.rootId]) continue;
                const estimated = item.maxLoadFactor * (this.tenantRates[this.collectives.find(c => c.id === item.collectiveId).colorIndex] || 0);
                bySpine[item.rootId].estimatedBlocks += estimated;
                bySpine[item.rootId].collectives[item.collectiveId] = estimated;
            }

            const phaseOffsets = {};
            let offset = 0;
            for (const item of rateAdvisor.perCollective.filter(c => c.members > 0).sort((a, b) => b.maxLoadFactor - a.maxLoadFactor)) {
                phaseOffsets[item.collectiveId] = offset;
                offset++;
            }

            return {
                method: 'root-spine-estimated-load',
                bySpine,
                recommendedPhaseOffsets: phaseOffsets,
                note: 'Offsets are advisory; when applied through startOffsetTicks, waiting time is included in CCT/FCT from tick 0.'
            };
        }

        applyStartOffsets(offsetSpec) {
            const spec = offsetSpec || {};
            for (const h of this.hosts) h.startOffsetTicks = 0;
            if (typeof spec === 'number') {
                for (const h of this.hosts) if (h.colorIndex !== null) h.startOffsetTicks = Math.max(0, Math.floor(spec));
                return;
            }
            for (const h of this.hosts) {
                if (h.colorIndex === null) continue;
                const collective = this.collectives[h.colorIndex];
                const candidates = [
                    h.id,
                    String(this.hosts.indexOf(h)),
                    collective.id,
                    collective.label,
                    COLOR_NAMES[h.colorIndex],
                    String(h.colorIndex)
                ];
                for (const key of candidates) {
                    if (Object.prototype.hasOwnProperty.call(spec, key)) {
                        h.startOffsetTicks = Math.max(0, Math.floor(Number(spec[key]) || 0));
                        break;
                    }
                }
            }
        }

        assumptionRegister() {
            return [
                'BARC address block claiming, ABI assignment, CA assignment, and multicast registration are treated as already completed before tick 0.',
                'Collective multicast forwarding uses precomputed CA egress state derived from the fixed topology and host placement.',
                'The data-plane behavior under study is stateless forwarding, congestion, drops, observability, and selective repair traffic.',
                'Fractional rates are represented by deterministic packet pacing with sub-tick source phases.',
                'Drop reports remain switch-local obligations until the corresponding repair returns to that switch.',
                'Repair arrival is an implicit acknowledgement; there is no separate ACK packet or transport connection.',
                'If startOffsetTicks is used, host data availability is still tick 0; offset waiting time is intentionally counted in CCT/FCT.'
            ];
        }

        runScenario(scenario) {
            this.resetSetup();
            this.appMode = 'run';
            this.runName = scenario.scenarioName || 'Unnamed';
            if (scenario.seed !== undefined) this.setSeed(Number(scenario.seed));
            if (scenario.capacity !== undefined) this.capacity = Number(scenario.capacity);
            if (scenario.bufferLimit !== undefined) this.bufferLimit = Number(scenario.bufferLimit);
            this.options.enableRecovery = scenario.enableRecovery !== undefined ? !!scenario.enableRecovery : true;
            this.options.controlPacketBlocks = scenario.controlPacketBlocks !== undefined ? Number(scenario.controlPacketBlocks) : 0.05;
            this.options.maxRepairAttempts = scenario.maxRepairAttempts === null
                ? null
                : (scenario.maxRepairAttempts !== undefined ? Number(scenario.maxRepairAttempts) : null);
            this.options.dropReportRetryBaseTicks = scenario.dropReportRetryBaseTicks !== undefined
                ? Number(scenario.dropReportRetryBaseTicks)
                : 8;
            this.options.dropReportRetryMaxTicks = scenario.dropReportRetryMaxTicks !== undefined
                ? Number(scenario.dropReportRetryMaxTicks)
                : 128;
            this.options.storageMode = scenario.storageMode || this.options.storageMode || 'full';
            this.losslessAdmissionControl = !!scenario.losslessAdmissionControl;

            const rates = scenario.rates || {};
            this.tenantRates[0] = rates.red !== undefined ? Number(rates.red) : 10;
            this.tenantRates[1] = rates.green !== undefined ? Number(rates.green) : 10;
            this.tenantRates[2] = rates.blue !== undefined ? Number(rates.blue) : 10;
            this.tenantRates[3] = rates.orange !== undefined ? Number(rates.orange) : 10;
            this.hostRateOverrides = Object.keys(scenario.hostRates || {}).reduce((acc, hostId) => {
                acc[hostId] = Math.max(0, Number(scenario.hostRates[hostId]) || 0);
                return acc;
            }, {});
            if (scenario.adaptiveRateControl && scenario.adaptiveRateControl.enabled) {
                const cfg = scenario.adaptiveRateControl;
                const baseRates = this.tenantRates.slice();
                const initialMultiplier = Number(cfg.initialMultiplier || 1.2);
                this.adaptiveRateControl = {
                    enabled: true,
                    baseRates,
                    initialMultiplier,
                    minMultiplier: Number(cfg.minMultiplier || 1),
                    maxMultiplier: Number(cfg.maxMultiplier || initialMultiplier),
                    decreaseFactor: Number(cfg.decreaseFactor || 0.8),
                    increaseStep: Number(cfg.increaseStep || 0.02),
                    increaseEveryTicks: Math.max(1, Number(cfg.increaseEveryTicks || 4)),
                    queueHighWatermark: Number(cfg.queueHighWatermark || 0.75),
                    currentRates: baseRates.map(rate => rate * initialMultiplier)
                };
            }
            if (scenario.adaptiveFeedback && scenario.adaptiveFeedback.enabled) {
                const cfg = scenario.adaptiveFeedback;
                const baseRates = this.tenantRates.slice();
                const initialMultiplier = Number(cfg.initialMultiplier || 1.2);
                this.adaptiveFeedback = {
                    enabled: true,
                    baseRates,
                    initialMultiplier,
                    minMultiplier: Number(cfg.minMultiplier || 1),
                    maxMultiplier: Number(cfg.maxMultiplier || initialMultiplier),
                    decreaseFactor: Number(cfg.decreaseFactor || 0.8),
                    increaseStep: Number(cfg.increaseStep || 0.02),
                    increaseEveryTicks: Math.max(1, Number(cfg.increaseEveryTicks || 4)),
                    highWatermark: Number(cfg.highWatermark || 0.75),
                    lowWatermark: Number(cfg.lowWatermark || 0.5),
                    coalesceTicks: Math.max(1, Number(cfg.coalesceTicks || 8)),
                    processingDelayTicks: Math.max(0, Number(cfg.processingDelayTicks || 1)),
                    currentRates: baseRates.map(rate => rate * initialMultiplier)
                };
            }

            const colors = scenario.hostColors || [];
            for (let i = 0; i < 16; i++) {
                if (i < colors.length && colors[i] !== null && colors[i] !== undefined) {
                    this.hosts[i].colorIndex = Number(colors[i]);
                }
            }
            if (this.adaptiveFeedback) {
                for (const host of this.hosts) {
                    if (host.colorIndex === null) continue;
                    this.hostRateOverrides[host.id] = this.adaptiveFeedback.currentRates[host.colorIndex];
                }
            }

            this.hostPayloadSize = scenario.payloadBlocks !== undefined ? Number(scenario.payloadBlocks) : 1000;
            this.computeForwardingState();
            this.applyStartOffsets(scenario.startOffsetTicks || scenario.startOffsets || null);
            if ((scenario.injectionMode || 'all_at_once') === 'sequential') {
                this.triggerSequential(this.hostPayloadSize);
            } else {
                this.triggerAll(this.hostPayloadSize);
            }

            const maxTicks = scenario.maxTicks || 50000;
            const maxWallClockMs = scenario.maxWallClockMs === undefined || scenario.maxWallClockMs === null
                ? null
                : Math.max(1, Number(scenario.maxWallClockMs) || 0);
            this.runtimeStartedAtMs = Date.now();
            this.runtimeWallClockLimitMs = maxWallClockMs;
            while (this.hasActiveDataInNetwork()) {
                this.step();
                if (this.currentTick > maxTicks) {
                    this.runtimeTimeoutReason = 'max-ticks';
                    break;
                }
                if (maxWallClockMs !== null && Date.now() - this.runtimeStartedAtMs > maxWallClockMs) {
                    this.runtimeTimeoutReason = 'wall-clock-timeout';
                    break;
                }
            }
            return this.buildReport(this.runName);
        }

        static reportToSummaryCsv(reports) {
            const rows = [];
            rows.push([
                'Scenario Name', 'Ticks', 'Total Injected', 'Repair Injected', 'Delivered',
                'Data Blocks', 'Total Drops', 'Control Reports', 'Control Blocks', 'Repair Blocks',
                'Feedback Reports', 'Rate Updates', 'Adaptive Control Blocks',
                'Retransmitted Reports', 'Total Waiting Offset Ticks', 'Pending Reports', 'Pending Repairs', 'Unrecovered Packets',
                'Drops Per Original Block', 'Repairs Per Original Block',
                'Original TX Complete Tick', 'Post TX Tail Ticks', 'Recovery Tail Ticks', 'Last Repair Completed Tick',
                'Capacity', 'Buffer Limit', 'Tenant Rates', 'Collective CCTs'
            ].join(','));
            for (const report of reports) {
                const cct = report.collectives
                    .filter(c => c.memberHosts.length > 0)
                    .map(c => `${c.collectiveId}:${c.complete ? c.cctTicks : 'FAILED'}`)
                    .join('|');
                rows.push([
                    csvCell(report.scenarioName),
                    report.summary.ticks,
                    report.summary.totalInjected,
                    report.summary.totalRepairsInjected,
                    report.summary.totalDelivered,
                    report.summary.totalDataBlocks,
                    report.summary.totalDrops,
                    report.summary.totalControlReports,
                    report.summary.totalControlBlocks,
                    report.summary.totalRepairBlocks,
                    report.summary.totalFeedbackReports || 0,
                    report.summary.totalRateUpdates || 0,
                    report.summary.totalAdaptiveControlBlocks || 0,
                    report.summary.retransmittedDropReports || 0,
                    report.summary.totalWaitingOffsetTicks || 0,
                    report.summary.pendingDropReports,
                    report.summary.pendingSourceRepairs,
                    report.summary.unrecoveredPackets,
                    report.summary.dropsPerOriginalBlock,
                    report.summary.repairsPerOriginalBlock,
                    report.summary.originalTxCompleteTick,
                    report.summary.postTxCompletionTailTicks,
                    report.summary.recoveryTailTicks,
                    report.summary.lastRepairCompletedTick,
                    report.config.capacity,
                    report.config.bufferLimit,
                    csvCell(report.config.tenantRates.join('|')),
                    csvCell(cct)
                ].join(','));
            }
            return rows.join('\n');
        }

        static reportToHostCsv(reports) {
            const rows = [];
            rows.push([
                'Scenario Name', 'Host', 'Collective', 'Start Offset Ticks',
                'Activation Tick', 'Original TX Complete Tick', 'Waiting Offset Ticks',
                'Configured Rate', 'Rx Total', 'Complete', 'CCT Ticks', 'Breakdown'
            ].join(','));
            for (const report of reports) {
                for (const h of report.hostStats) {
                    const breakdown = h.breakdown.map(b => `${b.sourceHost}:${b.received}/${b.expected}:${b.complete ? b.fctTicks : 'DROPPED'}`).join('|');
                    rows.push([
                        csvCell(report.scenarioName),
                        h.hostId,
                        h.collectiveId || 'inactive',
                        h.startOffsetTicks || 0,
                        h.activationTick === null || h.activationTick === undefined ? '' : h.activationTick,
                        h.originalTxCompleteTick === null || h.originalTxCompleteTick === undefined ? '' : h.originalTxCompleteTick,
                        h.waitingOffsetTicks || 0,
                        h.configuredRate,
                        h.rxTotal,
                        h.complete,
                        h.cctTicks === null ? '' : h.cctTicks,
                        csvCell(breakdown)
                    ].join(','));
                }
            }
            return rows.join('\n');
        }

        static reportToDropCsv(reports) {
            const rows = [];
            rows.push([
                'Scenario Name', 'Drop ID', 'Tick', 'Reason', 'Switch', 'Switch Type', 'Port',
                'Packet ID', 'Kind', 'Collective', 'CA', 'Source Host', 'Seq No',
                'Affected Count', 'Affected Hosts', 'Queue Depth', 'Queue Blocks',
                'Packet Size Blocks', 'Pending Report ID', 'Attempt', 'Capacity', 'Buffer Limit'
            ].join(','));
            for (const report of reports) {
                for (const d of report.dropLedger) {
                    rows.push([
                        csvCell(report.scenarioName),
                        d.id,
                        d.tick,
                        d.reason,
                        d.switchId,
                        d.switchType,
                        d.portKey,
                        csvCell(d.packetId),
                        d.packetKind,
                        d.collectiveId,
                        d.caId,
                        d.sourceHost,
                        d.seqNo,
                        d.affectedCount,
                        csvCell(d.affectedHosts.join('|')),
                        d.queueDepth,
                        d.queueBlocks,
                        d.packetSizeBlocks,
                        d.pendingReportId,
                        d.attempt,
                        d.capacity,
                        d.bufferLimit
                    ].join(','));
                }
            }
            return rows.join('\n');
        }

        static reportToRecoveryCsv(reports) {
            const rows = [];
            rows.push([
                'Scenario Name', 'Report ID', 'Original Packet ID', 'Source Host', 'Dropped Switch',
                'Dropped Port', 'Affected Hosts', 'Attempt', 'Created Tick', 'Sent Tick',
                'Last Sent Tick', 'Received Tick', 'Acknowledged Tick', 'Report Sends',
                'Repair Queued Tick', 'Repair Switch Tick', 'Repair Completed Tick',
                'Total Recovery Ticks'
            ].join(','));
            for (const report of reports) {
                for (const item of report.recoveryLatencies || []) {
                    const control = (report.controlLedger || []).find(r => r.id === item.reportId) || {};
                    rows.push([
                        csvCell(report.scenarioName),
                        item.reportId,
                        csvCell(item.originalPacketId),
                        control.sourceHost || '',
                        control.droppedSwitchId || '',
                        control.droppedPortKey || '',
                        csvCell((control.affectedHosts || []).join('|')),
                        control.attempt || 0,
                        control.createdTick,
                        item.reportSentTick,
                        item.reportLastSentTick,
                        item.reportReceivedTick,
                        item.reportAcknowledgedTick,
                        item.reportSendCount,
                        item.repairQueuedTick,
                        item.repairSwitchTick,
                        item.repairCompletedTick,
                        item.totalRecoveryTicks
                    ].join(','));
                }
            }
            return rows.join('\n');
        }
    }

    function csvCell(value) {
        const str = String(value === null || value === undefined ? '' : value);
        if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
        return str;
    }

    return {
        BARCResearchSim,
        SimNode,
        Port,
        COLOR_NAMES,
        COLOR_LABELS
    };
});
