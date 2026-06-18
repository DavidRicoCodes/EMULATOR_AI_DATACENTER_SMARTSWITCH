(function () {
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    let W;
    let H;

    const sim = new BARCResearchSim({
        capacity: 10,
        bufferLimit: 64,
        seed: 1,
        enableEventLog: true
    });
    window.barcSim = sim;

    const colors = ['#ff4757', '#2ed573', '#1e90ff', '#ffa502'];
    const colorLabels = ['Red', 'Green', 'Blue', 'Orange'];

    const btnPlay = document.getElementById('btnPlay');
    const btnPause = document.getElementById('btnPause');
    const btnReset = document.getElementById('btnReset');
    const btnResetTraffic = document.getElementById('btnResetTraffic');
    const btnTriggerAll = document.getElementById('btnTriggerAll');
    const btnTriggerSeq = document.getElementById('btnTriggerSeq');
    const btnExportJson = document.getElementById('btnExportJson');
    const btnExportCsv = document.getElementById('btnExportCsv');
    const modeFlag = document.getElementById('modeFlag');
    const sliderSpeed = document.getElementById('sliderSpeed');
    const valSpeed = document.getElementById('valSpeed');
    const contextMenu = document.getElementById('context-menu');
    const btnToggleBatch = document.getElementById('btnToggleBatch');
    const batchPanel = document.getElementById('batch-panel');
    const btnRunBatch = document.getElementById('btnRunBatch');
    const batchTextarea = document.getElementById('batchTextarea');

    let isPlaying = false;
    let tickDuration = parseInt(sliderSpeed.value, 10);
    let simTimer = 0;
    let mouseX = -1000;
    let mouseY = -1000;
    let hoveredHost = null;
    let selectedHostForMenu = null;

    sliderSpeed.addEventListener('input', (e) => {
        tickDuration = parseInt(e.target.value, 10);
        valSpeed.innerText = tickDuration;
    });

    for (let i = 0; i < 4; i++) {
        const slider = document.getElementById(`sliderRate${i}`);
        const valSpan = document.getElementById(`valRate${i}`);
        slider.addEventListener('input', (e) => {
            sim.setTenantRate(i, parseInt(e.target.value, 10));
            const rate = Number(sim.tenantRates[i]);
            valSpan.innerText = `${rate.toFixed(2)} (${(rate * 100).toFixed(1)} MB/s)`;
        });
    }

    function formatBytes(blocks) {
        const mb = blocks * 100;
        if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
        return `${mb} MB`;
    }

    function updateUI() {
        btnPlay.classList.toggle('active', isPlaying);
        btnPause.classList.toggle('active', !isPlaying);
        modeFlag.className = sim.appMode;
        modeFlag.innerText = `${sim.appMode} MODE`;
        const helper = document.getElementById('helper');
        if (sim.appMode === 'setup') {
            helper.innerText = 'SETUP MODE: Click Hosts to assign Collective Colors. Press Play or Trigger to run.';
        } else {
            helper.innerText = 'RUN MODE: Hover hosts for CCT/FCT. Export JSON/CSV for drop ledger and heatmaps.';
        }
    }

    function switchToRunMode() {
        sim.switchToRunMode();
        isPlaying = true;
        updateUI();
    }

    btnPlay.onclick = () => {
        switchToRunMode();
    };

    btnPause.onclick = () => {
        isPlaying = false;
        updateUI();
    };

    btnTriggerAll.onclick = () => {
        sim.triggerAll(100);
        isPlaying = true;
        updateUI();
    };

    btnTriggerSeq.onclick = () => {
        sim.triggerSequential(100);
        isPlaying = true;
        updateUI();
    };

    btnReset.onclick = () => {
        isPlaying = false;
        simTimer = 0;
        sim.resetSetup();
        updateUI();
        draw(0);
    };

    btnResetTraffic.onclick = () => {
        isPlaying = false;
        simTimer = 0;
        sim.resetTraffic();
        updateUI();
        draw(0);
    };

    if (btnExportJson) {
        btnExportJson.onclick = () => {
            const report = sim.buildReport('interactive');
            downloadText('interactive_report.json', JSON.stringify(report, null, 2), 'application/json');
        };
    }

    if (btnExportCsv) {
        btnExportCsv.onclick = () => {
            const report = sim.buildReport('interactive');
            downloadText('interactive_summary.csv', BARCResearchSim.reportToSummaryCsv([report]), 'text/csv');
            downloadText('interactive_hosts.csv', BARCResearchSim.reportToHostCsv([report]), 'text/csv');
            downloadText('interactive_drops.csv', BARCResearchSim.reportToDropCsv([report]), 'text/csv');
            downloadText('interactive_recovery.csv', BARCResearchSim.reportToRecoveryCsv([report]), 'text/csv');
        };
    }

    document.querySelectorAll('.ctx-item').forEach(item => {
        item.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            if (selectedHostForMenu) {
                const colorVal = item.getAttribute('data-color');
                sim.setHostColor(selectedHostForMenu.id, colorVal === 'null' ? null : parseInt(colorVal, 10));
                sim.computeForwardingState();
            }
            contextMenu.style.display = 'none';
            selectedHostForMenu = null;
            draw(0);
        });
    });

    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        mouseX = e.clientX - rect.left;
        mouseY = e.clientY - rect.top;
        hoveredHost = null;
        for (const h of sim.hosts) {
            const dx = h.x - mouseX;
            const dy = h.y - mouseY;
            if (dx * dx + dy * dy < 400) {
                hoveredHost = h;
                break;
            }
        }
    });

    canvas.addEventListener('mousedown', (e) => {
        if (contextMenu.style.display === 'block') {
            contextMenu.style.display = 'none';
            return;
        }

        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        for (const h of sim.hosts) {
            const dx = h.x - mx;
            const dy = h.y - my;
            if (dx * dx + dy * dy < 600) {
                if (sim.appMode === 'setup') {
                    selectedHostForMenu = h;
                    contextMenu.style.left = `${e.clientX}px`;
                    contextMenu.style.top = `${e.clientY}px`;
                    contextMenu.style.display = 'block';
                } else if (sim.appMode === 'run' && h.colorIndex !== null) {
                    sim.isSequentialMode = false;
                    if (h.active) {
                        h.active = false;
                    } else {
                        if (h.pending === 0) h.pending = sim.hostPayloadSize;
                        h.active = true;
                    }
                }
                draw(0);
                break;
            }
        }
    });

    btnToggleBatch.onclick = () => {
        batchPanel.style.display = batchPanel.style.display === 'none' ? 'block' : 'none';
    };

    btnRunBatch.onclick = () => {
        let scenarios = [];
        try {
            scenarios = JSON.parse(batchTextarea.value);
        } catch (e) {
            alert('Invalid JSON in Batch Runner!');
            return;
        }

        const reports = [];
        for (const scenario of scenarios) {
            reports.push(sim.runScenario(scenario));
        }

        downloadText('batch_results_summary.csv', BARCResearchSim.reportToSummaryCsv(reports), 'text/csv');
        downloadText('batch_results_hosts.csv', BARCResearchSim.reportToHostCsv(reports), 'text/csv');
        downloadText('batch_results_drops.csv', BARCResearchSim.reportToDropCsv(reports), 'text/csv');
        downloadText('batch_results_recovery.csv', BARCResearchSim.reportToRecoveryCsv(reports), 'text/csv');
        downloadText('batch_results_full.json', JSON.stringify(reports, null, 2), 'application/json');

        isPlaying = false;
        sim.resetSetup();
        updateUI();
        draw(0);
    };

    function downloadText(filename, text, mimeType) {
        const blob = new Blob([text], { type: mimeType || 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function layoutTopology() {
        const h10 = H * 0.15;
        const h40 = H * 0.40;
        const h70 = H * 0.65;
        const h90 = H * 0.85;
        sim.cores.forEach((n, i) => { n.x = (W / 5) * (i + 1); n.y = h10; });
        sim.aggs.forEach((n, i) => { n.x = (W / 9) * (i + 1); n.y = h40; });
        sim.edges.forEach((n, i) => { n.x = (W / 9) * (i + 1); n.y = h70; });
        sim.hosts.forEach((n, i) => { n.x = (W / 17) * (i + 1); n.y = h90; });
    }

    function resize() {
        W = window.innerWidth;
        H = window.innerHeight;
        canvas.width = W;
        canvas.height = H;
        layoutTopology();
    }

    window.addEventListener('resize', resize);

    let lastTime = performance.now();
    function render(time) {
        const dt = time - lastTime;
        lastTime = time;
        requestAnimationFrame(render);

        if (isPlaying) {
            simTimer += dt;
            while (simTimer >= tickDuration) {
                sim.step();
                simTimer -= tickDuration;
            }
            if (!sim.hasActiveDataInNetwork() && sim.inflight.length === 0) {
                isPlaying = false;
                updateUI();
            }
        }
        draw(dt);
    }

    CanvasRenderingContext2D.prototype.roundRectCustom = function (x, y, w, h, r) {
        if (w < 2 * r) r = w / 2;
        if (h < 2 * r) r = h / 2;
        this.moveTo(x + r, y);
        this.arcTo(x + w, y, x + w, y + h, r);
        this.arcTo(x + w, y + h, x, y + h, r);
        this.arcTo(x, y + h, x, y, r);
        this.arcTo(x, y, x + w, y, r);
        return this;
    };

    function draw(dt) {
        ctx.clearRect(0, 0, W, H);

        drawLinks();
        drawInflightPackets();
        drawDropEvents(dt);
        drawNodes();
        drawHoverTooltip();
    }

    function drawLinks() {
        for (const l of sim.allLinks) {
            const pA = l.a;
            const pB = l.b;
            const ptA = pA.getCenter();
            const ptB = pB.getCenter();
            const blocksTraversed = Math.max(pA.lastTraversed || 0, pB.lastTraversed || 0);
            const pct = Math.round((blocksTraversed / sim.capacity) * 100);

            ctx.lineWidth = 2;
            if (pct === 0) ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            else if (pct <= 50) ctx.strokeStyle = 'rgba(46, 213, 115, 0.8)';
            else if (pct < 100) ctx.strokeStyle = 'rgba(255, 165, 2, 0.9)';
            else ctx.strokeStyle = 'rgba(255, 71, 87, 1.0)';

            ctx.beginPath();
            ctx.moveTo(ptA.x, ptA.y);
            ctx.lineTo(ptB.x, ptB.y);
            ctx.stroke();

            if (pct > 0) {
                const midX = ptA.x + (ptB.x - ptA.x) * 0.5;
                const midY = ptA.y + (ptB.y - ptA.y) * 0.5;
                ctx.fillStyle = ctx.strokeStyle;
                ctx.font = 'bold 9px Inter, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(`${pct}%`, midX + 12, midY + 4);
            }
        }
    }

    function drawInflightPackets() {
        for (const pkt of sim.inflight) {
            let prog = simTimer / tickDuration;
            prog -= pkt.offset;
            if (prog < 0) prog = 0;
            if (prog > 1) prog = 1;

            const pA = pkt.sourcePort.getCenter();
            const pB = pkt.targetPort.getCenter();
            const dx = pB.x - pA.x;
            const dy = pB.y - pA.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const nx = -dy / len;
            const ny = dx / len;
            const isRepair = pkt.block.kind === 'repair-to-switch' || pkt.block.kind === 'repair-subtree';
            const isControl = pkt.block.kind === 'drop-report';
            const laneOffset = isRepair ? -6 : (isControl ? 0 : 6);
            const px = pA.x + dx * prog + nx * laneOffset;
            const py = pA.y + dy * prog + ny * laneOffset;
            const color = pkt.block.colorIndex !== null ? colors[pkt.block.colorIndex] : '#ffffff';

            ctx.fillStyle = isControl ? '#f8f8f2' : color;
            ctx.shadowBlur = isRepair ? 14 : 8;
            ctx.shadowColor = color;
            if (isRepair) {
                ctx.beginPath();
                ctx.arc(px, py, 5, 0, Math.PI * 2);
                ctx.fill();
            } else if (isControl) {
                ctx.beginPath();
                ctx.moveTo(px, py - 5);
                ctx.lineTo(px + 5, py);
                ctx.lineTo(px, py + 5);
                ctx.lineTo(px - 5, py);
                ctx.closePath();
                ctx.fill();
            } else {
                ctx.fillRect(px - 4, py - 4, 8, 8);
            }
        }
        ctx.shadowBlur = 0;
    }

    function drawDropEvents(dt) {
        for (let i = sim.dropEvents.length - 1; i >= 0; i--) {
            const d = sim.dropEvents[i];
            d.age += dt;
            const lifespan = 500;
            if (d.age > lifespan) {
                sim.dropEvents.splice(i, 1);
                continue;
            }

            const alpha = 1 - d.age / lifespan;
            ctx.strokeStyle = `rgba(255,70,70,${alpha})`;
            ctx.lineWidth = 2 + (d.age / lifespan) * 2;
            ctx.beginPath();
            const s = 5;
            ctx.moveTo(d.x - s, d.y - s);
            ctx.lineTo(d.x + s, d.y + s);
            ctx.moveTo(d.x + s, d.y - s);
            ctx.lineTo(d.x - s, d.y + s);
            ctx.stroke();
        }
    }

    function drawNodes() {
        for (const n of sim.allNodes) {
            if (n.type === 'Host') {
                drawHost(n);
            } else {
                drawSwitch(n);
            }
        }
    }

    function drawHost(n) {
        ctx.fillStyle = n.colorIndex !== null ? colors[n.colorIndex] : '#2f364a';
        ctx.beginPath();
        ctx.arc(n.x, n.y, 16, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = '10px Inter, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(n.id, n.x, n.y - 22);
        ctx.fillText(`P:${n.pending} (${formatBytes(n.pending)})`, n.x, n.y + 32);
        ctx.fillText(`C:${n.completed} (${formatBytes(n.completed)})`, n.x, n.y + 44);

        if (n.active) {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(n.x, n.y, 20, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    function drawSwitch(n) {
        ctx.fillStyle = '#1e2235';
        ctx.fillRect(n.x - n.w / 2, n.y - n.h / 2, n.w, n.h);
        ctx.strokeStyle = '#4a5472';
        ctx.lineWidth = 1;
        ctx.strokeRect(n.x - n.w / 2, n.y - n.h / 2, n.w, n.h);

        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = '10px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(n.id, n.x, n.y + 4);

        const pw = 16;
        const ph = 10;
        for (const p of n.upPorts.concat(n.downPorts)) {
            const pt = p.getCenter();
            const qBlocks = sim.queueOccupancy ? sim.queueOccupancy(p) : p.queue.length;
            const qPct = sim.bufferLimit ? Math.min(1, qBlocks / sim.bufferLimit) : 0;
            ctx.fillStyle = p.activeColor !== null ? colors[p.activeColor] : (qPct > 0 ? `rgba(255,165,2,${0.25 + qPct * 0.6})` : '#0d0f14');
            ctx.fillRect(pt.x - pw / 2, pt.y - ph / 2, pw, ph);
            ctx.strokeStyle = p.activeColor !== null ? colors[p.activeColor] : '#7582a5';
            ctx.strokeRect(pt.x - pw / 2, pt.y - ph / 2, pw, ph);

            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.font = '8px Inter';
            let ty = p.offsetY < 0 ? pt.y + 14 : pt.y - 7;
            if (n.type === 'SS') ty = pt.y - 8;
            ctx.fillText(qBlocks > 0 ? `${p.id}:${qBlocks.toFixed(qBlocks < 10 ? 1 : 0)}` : p.id, pt.x, ty);
        }
    }

    function drawHoverTooltip() {
        if (!hoveredHost || hoveredHost.colorIndex === null) return;
        const siblings = sim.hosts.filter(h => h.colorIndex === hoveredHost.colorIndex && h.id !== hoveredHost.id);
        if (siblings.length === 0) return;

        const lines = ['Rx Breakdown:'];
        let maxFct = 0;
        let hasDropped = false;
        for (const sib of siblings) {
            const received = hoveredHost.receivedStats[sib.id] || 0;
            const fctTicks = hoveredHost.fctStats[sib.id];
            let fctStr = '';
            if (received < sim.hostPayloadSize) {
                fctStr = '(MISSING)';
                hasDropped = true;
            } else {
                fctStr = `(FCT: ${fctTicks}t)`;
                if (fctTicks > maxFct) maxFct = fctTicks;
            }
            lines.push(`From ${sib.id}: ${received}/${sim.hostPayloadSize} ${fctStr}`);
        }
        lines.push('');
        lines.push(`Overall CCT: ${hasDropped ? 'FAILED' : `${maxFct}t`}`);
        lines.push(`Drops in run: ${sim.totalDrops}`);
        lines.push(`Reports: ${sim.totalControlReports || 0} Repairs: ${sim.totalRepairsInjected || 0}`);

        ctx.font = '11px Inter, sans-serif';
        let tw = 0;
        for (const l of lines) tw = Math.max(tw, ctx.measureText(l).width);
        tw += 20;
        const th = lines.length * 16 + 10;
        let tooltipX = hoveredHost.x + 15;
        const tooltipY = hoveredHost.y - th - 15;
        if (tooltipX + tw > W) tooltipX = hoveredHost.x - tw - 15;

        ctx.fillStyle = 'rgba(20, 25, 35, 0.95)';
        ctx.strokeStyle = colors[hoveredHost.colorIndex];
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRectCustom(tooltipX, tooltipY, tw, th, 6);
        ctx.fill();
        ctx.stroke();

        ctx.textAlign = 'left';
        for (let i = 0; i < lines.length; i++) {
            ctx.fillStyle = i === 0 ? colors[hoveredHost.colorIndex] : '#e0e6f0';
            ctx.font = i === 0 ? 'bold 11px Inter, sans-serif' : '11px Inter, monospace';
            ctx.fillText(lines[i], tooltipX + 10, tooltipY + 16 + i * 16);
        }
    }

    resize();
    updateUI();
    draw(0);
    requestAnimationFrame(render);
})();
