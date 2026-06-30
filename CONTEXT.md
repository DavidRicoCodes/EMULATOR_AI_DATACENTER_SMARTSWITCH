# BARC Multicast Smart-Switch Research Context

Ultima actualizacion: 2026-06-30  
Workspace raiz: `C:\Users\user\Desktop\WEB\data`

Este documento es el contexto canonico para retomar el proyecto desde otro chat. Resume que se esta investigando, como funciona el emulador, que decisiones se tomaron, que se implemento, que datasets existen, que resultados hay, que problemas se corrigieron y cuales son los siguientes pasos recomendados.

## 1. Objetivo De Investigacion

El proyecto estudia multicast collectives en un datacenter tipo Clos/fat-tree usando BARC como substrato de direccionamiento/routing ya existente. El foco no es implementar ni evaluar el control plane completo de BARC, sino usar las ideas de BARC y multicast collectives para investigar:

- Donde aparecen drops y hotspots en trafico multicast colectivo.
- Como distribuir hosts/colectivos en la red para reducir congestion.
- Como medir CCT/FCT por colectivo y por host.
- Si una politica con pequenas perdidas recuperables puede ganar en completion time frente a una politica lossless ideal.
- Que coste introduce un mecanismo de smart-switch recovery.
- Que pasa cuando el control adaptativo es ideal/oracle frente a cuando tiene que usar mensajes reales en la misma red.

La pregunta central actual es:

> Puede una politica de controlled loss + selective recovery mejorar el Collective Completion Time respecto a una politica idealizada lossless, manteniendo completion al 100%?

Completion es criterio obligatorio. Si una politica no completa, no sirve para el caso AI/datacenter salvo como control negativo o evidencia de inestabilidad.

## 2. Documentacion Base En La Raiz

Los PDFs/textos originales en la raiz que motivan el emulador:

- `1-24-0014-00.pdf` / `1-24-0014-00.txt`
  - Observaciones sobre Layer 2 Clos fat-tree.
- `collective-multicast-r1 (1).pdf` / `collective-multicast-r1.txt`
  - Collective Multicast in a Fat Tree.
- `cq-Marks-collective-multicast-0324-v00 (1).pdf` / `cq-Marks-collective-multicast-0324-v00.txt`
  - Data Center Collective Multicast using BARC-assigned Address Blocks.

Supuestos derivados:

- BARC registration, ABI assignment, CA assignment e initial forwarding state se asumen ya hechos antes de tick 0.
- No se esta estudiando el protocolo de registro BARC ni los paquetes de control BARC originales.
- Lo que se estudia es el dataplane: stateless multicast/unicast forwarding, congestion, drops, observabilidad, recovery selectivo y rate control.

## 3. Estado General Del Proyecto

El proyecto empezo como un HTML monolitico (`emulator.html` + `emulator-app.js`) y se separo en:

- Core determinista testeable:
  - `barc-sim-core.js`
- Runner de experimentos:
  - `experiment-runner.js`
  - `campaign-runner.js`
- Analisis:
  - `campaign-analysis.js`
  - `final-research-analysis.py`
- Correccion adaptive:
  - `adaptive-correction-runner.js`
  - `build-corrected-dataset.js`
- Seleccion forensic:
  - `select-forensic-cases.js`
- PDF final:
  - `generate-research-report.py`
  - `verify-research-report.py`
- Tests:
  - `barc-sim-tests.js`
  - `campaign-tests.js`
  - `research-pipeline-tests.js`

Artefacto PDF final actual:

- `output/pdf/barc_multicast_adaptive_research_report.pdf`
- Validado con Poppler: 43 paginas renderizadas, `valid: true`, sin violaciones.
- QA visual en:
  - `tmp/pdfs/barc-report-qa/contact-01.png`
  - `tmp/pdfs/barc-report-qa/contact-02.png`
  - `tmp/pdfs/barc-report-qa/contact-03.png`
  - `tmp/pdfs/barc-report-qa/contact-04.png`

## 4. Topologia Del Emulador

El emulador usa una topologia fija pequena:

- 16 hosts.
- 4 pods.
- 2 racks por pod.
- 2 hosts por rack.
- Switches en capas tipo Clos/fat-tree:
  - RS: rack switches.
  - FS: fabric/aggregation switches.
  - SS: spine/core switches.
- Cada colectivo tiene un color/logical ID:
  - red, green, blue, orange.
- Cada color tiene un Collective Anchor / root asociado:
  - `CA_RED_SS0`, `CA_GREEN_SS1`, etc.

Importante:

- La topologia fisica NO cambia con el seed.
- El seed solo cambia asignaciones reproducibles en `random-balanced` y tambien se usa para asignar capacity/buffer de manera estratificada en algunas fases.

## 5. Placements Y Seeds

Los placements implementados son:

- `rack-compact`
  - Llena hosts cercanos en el mismo rack/pod primero.
- `pod-compact`
  - Mantiene los hosts dentro de pods compactos.
- `pod-spread`
  - Distribuye posiciones equivalentes entre pods.
- `global-spread`
  - Orden manual que reparte hosts globalmente.
- `adversarial-shared-uplink`
  - Orden manual que intenta alinear hosts sobre uplinks compartidos para generar bottlenecks.
- `random-balanced`
  - Baraja los 16 hosts con un RNG determinista a partir del seed.

Como se asignan hosts a colectivos:

- Un perfil es un vector de tamanos.
- Ejemplos:
  - `[4]`: un colectivo con 4 hosts.
  - `[8]`: un colectivo con 8 hosts.
  - `[16]`: un colectivo con 16 hosts.
  - `[4,4]`: dos colectivos simultaneos de 4 hosts.
  - `[8,8]`: dos colectivos simultaneos de 8 hosts.
  - `[2,6,8]`: tres colectivos simultaneos heterogeneos.
  - `[2,2,4,8]`: cuatro colectivos simultaneos.
- El perfil se coloca sobre la lista ordenada de hosts del placement.
- En `random-balanced`, esa lista se obtiene con `shuffle(hosts, seed)`.

Rangos usados:

- Hosts por colectivo: 2 a 16.
- Colectivos simultaneos: 1 a 4.
- Payloads: 100, 1,000 y 10,000 bloques.
- Capacities: 5, 10, 20 bloques/tick.
- Buffers: 8, 16, 32, 64, 128 bloques.

## 6. Packet/Queue Model

Cada puerto tiene una sola FIFO:

- No hay colas separadas para data/control/repair.
- No hay prioridad estricta.
- Data, drop reports, repairs, congestion reports y rate updates comparten la misma cola si llegan al puerto.

Tamanos:

- `data-multicast`: 1 bloque.
- `repair-to-switch`: 1 bloque.
- `repair-subtree`: 1 bloque.
- `drop-report`: 0.05 bloques.
- `congestion-report`: 0.05 bloques.
- `rate-update`: 0.05 bloques.

Capacidad/buffer:

- La capacidad se mide en bloques/tick.
- Buffer se mide en ocupacion por bloques, no numero de paquetes.
- Fractional rates se representan con pacing determinista mediante creditos por host.

## 7. Mecanismo De Selective Recovery

Tipos de paquetes implementados:

- `data-multicast`
- `drop-report`
- `repair-to-switch`
- `repair-subtree`
- `congestion-report`
- `rate-update`

### 7.1 Que pasa al dropear

Cuando un switch/puerto no puede admitir una copia multicast:

1. Se crea una entrada inmediata en `dropLedger`.
2. Se actualizan contadores por interfaz/layer/collective/kind.
3. Se crea o mergea un `pendingDropReport`.
4. Si recovery esta deshabilitado, solo queda el drop.

Campos conceptuales del drop/report:

- `sourceHost`
- `originalPacketId`
- `droppedSwitchId`
- `droppedPortKey`
- `affectedHosts`
- `attempt`
- `firstDropTick`
- `collectiveId`
- `caId`

El report se coalescea por:

```text
sourceHost + originalPacketId + droppedSwitchId + affectedPortKeys + attempt
```

Por tanto, no se envia un paquete de control por cada host afectado. Conceptualmente es un report por obligacion de reparacion: un paquete original, un switch, uno o varios puertos/subarboles afectados y una lista de hosts afectados.

### 7.2 Memoria Del Switch

Punto importante para explicarlo:

- El switch NO necesita guardar el payload completo del paquete.
- Guarda identificadores y metadata compacta:
  - packet id/original id,
  - puerto afectado,
  - hosts afectados,
  - intento,
  - ticks/estado.
- El emulador guarda ledgers y mapas extra para analisis/forensics, pero eso no debe interpretarse como memoria requerida por hardware.
- El contenido/replay del paquete viene del origen (`packetStore` en el emulador). En hardware real esto tendria que mapearse a un replay buffer del host/NIC/origen.

### 7.3 Cuando se manda el drop-report

El report NO se manda inmediatamente al dropear.

Se difiere hasta que:

```js
sourceAvailableForRepair(sourceHostId)
```

sea cierto, es decir:

- el host origen tiene `pending === 0`,
- y `active === false`.

Esto significa que el origen ya termino de inyectar su trafico original. La intencion de investigacion fue evitar meter reports en plena fase de transmision masiva y hacer que el origen este disponible para reparar.

Si el puerto de salida no puede aceptar el report:

- no se fuerza,
- no se expulsa data,
- el report queda pendiente fuera de la FIFO,
- se reintenta en ticks posteriores.

Todos los switches con reports pendientes intentan liberarlos cuando toca, pero no tienen prioridad especial ni canal separado. En la practica compiten por la FIFO normal.

### 7.4 Como se repara

Cuando el origen recibe un `drop-report`:

1. Busca el payload/original en `packetStore`.
2. Agenda un `repair-to-switch`.
3. Ese repair viaja en unicast hacia el switch que dropeo.
4. Cuando llega a `droppedSwitchId`, ese switch genera `repair-subtree`.
5. `repair-subtree` solo sale por los puertos afectados.
6. Los hosts deduplican por `originalPacketId`.

Esto evita repetir el multicast completo original.

Si se dropea un repair, se genera otra obligacion de report/retry. En la version final, `maxRepairAttempts` esta en `null` para permitir eventual recovery hasta timeout/guardrail.

## 8. Rate Advisor, Lossless Y Overdrive

### 8.1 Advisor lossless

El advisor es offline/global en el emulador. Conoce:

- placement de hosts,
- miembros de cada colectivo,
- forwarding state/arbol multicast,
- capacity,
- buffer.

Para cada fuente activa, traza el multicast esperado sobre la topologia y calcula carga por link. Luego busca:

```text
combinedMaxLoadFactor
```

La tasa uniforme lossless aproximada es:

```text
losslessRate = effectiveLosslessCapacity / combinedMaxLoadFactor
effectiveLosslessCapacity = min(capacity, bufferLimit)
```

En codigo aparece como:

- `rateAdvisor.combinedRecommendedUniformRate`
- `rateAdvisor.combinedRecommendedIntegerRate`
- `rateAdvisor.perSourceRecommendedRates`
- `rateAdvisor.perCollective[].bottleneckLinks`

Per-source lossless:

- Usa max-min progressive filling sobre cargas trazadas por fuente.
- Puede mejorar en perfiles heterogeneos cuando distintas fuentes no comparten exactamente el bottleneck.
- En resultados suele empatar o estar muy cerca de exact lossless, con alguna divergencia.

### 8.2 Overdrive

`advisor-overdrive-a1.05` usa la tasa lossless como base:

```text
selectedRate = min(capacity, losslessRate * 1.05)
```

Importante:

- 1.05 NO significa 1.05%.
- Significa 105% del rate lossless.
- Es un overdrive del 5%.

Por eso la politica intenta ganar reduciendo tiempo de transmision original, aceptando algunos drops que luego recovery repara. Gana si:

```text
ahorro en original TX > recovery tail + control overhead + queueing adicional
```

Pierde si el recovery tail crece mas que el ahorro.

### 8.3 Hardware real

En el emulador el advisor es offline/global. En hardware real:

- Un CA/root/spine podria calcularlo para su colectivo si conoce membership y forwarding tree.
- Si hay multiples colectivos/roots/spines compartiendo links, hace falta coordinacion o telemetria compartida para estimar `combinedMaxLoadFactor` global.
- Esto queda como decision de investigacion futura.

## 9. Adaptive Oracle Y Feedback

### 9.1 Adaptive oracle

El oracle no es omnisciente ni optimizador global. Es ideal en observabilidad:

- observa drops y queue occupancy sin coste,
- no paga mensajes de control,
- ajusta rates reactivamente.

Regla:

- Empieza por encima del lossless base con `initialMultiplier`.
- Si hay drops o cola alta, reduce multiplicativamente con `decreaseFactor`.
- Si esta estable, incrementa aditivamente cada `increaseEveryTicks`.
- Respeta `minMultiplier` y `maxMultiplier`.

Puede perder contra exact lossless porque:

- reacciona despues de que la cola ya se formo,
- reduce demasiado,
- aumenta demasiado lento,
- crea repair work que lossless evita,
- sincroniza fuentes en bursts,
- el ahorro de transmision original puede ser menor que el recovery tail.

### 9.2 Tuning oracle

Se corrigio un bug importante: adaptive inicialmente heredaba `losslessAdmissionControl=true` al clonarse de exact lossless. Eso era metodologicamente incorrecto. Se repitieron solo las 3,720 runs adaptive afectadas con:

```text
losslessAdmissionControl = false
enableRecovery = true
admissionMode = lossy-fifo-with-selective-recovery
```

Latin Hypercube:

- Seed: `20260618`
- 12 candidatos.
- Dimensiones:
  - `initialMultiplier`: 1.05-1.35
  - `queueHighWatermark`: 0.50-0.90
  - `decreaseFactor`: 0.70-0.95
  - `increaseStep`: 0.01-0.05

Proceso:

1. B-training evalua 12 configuraciones.
2. Se eligen top 3.
3. B-validation elige una.
4. C/D/E evaluan held-out.

Seleccion final corregida:

```json
{
  "bestFixedAlphaPolicy": "advisor-overdrive-a1.05",
  "topAdaptiveTrainingPolicies": [
    "adaptive-lhs-01",
    "adaptive-lhs-02",
    "adaptive-lhs-12"
  ],
  "bestAdaptiveOraclePolicy": "adaptive-lhs-02",
  "bestAdaptiveFeedbackPolicy": "adaptive-feedback-d4"
}
```

### 9.3 Adaptive feedback D1/D4/D8

Realistic feedback:

- Detecta congestion por threshold crossing de cola por puerto.
- Coalesce cada `coalesceTicks = 8`.
- Envia `congestion-report` de 0.05 bloques al CA/root.
- El CA/root procesa con delay adicional D1/D4/D8.
- Envia `rate-update` de 0.05 bloques a fuentes.
- Todo comparte la misma FIFO que data/repair/drop reports.
- Los mensajes pueden sufrir congestion o drops.

`D1`, `D4`, `D8` significan delay de procesamiento adicional de 1, 4 u 8 ticks.

## 10. Politicas Evaluadas

Principales:

- `advisor-exact-lossless`
  - Baseline idealizada lossless.
  - Usa advisor uniform rate.
  - Usa admission/backpressure idealizado.
  - Debe tener cero drops.
- `per-source-lossless`
  - Lossless con rates por fuente max-min.
  - Baseline idealizada.
- `advisor-overdrive-a1.05`
  - 105% del rate lossless.
  - Recovery habilitado.
  - Candidato principal no-lossless.
- `selected-adaptive-oracle`
  - Adaptive oracle corregido.
  - Lossy FIFO + recovery.
  - Sin coste de señalizacion.
- `adaptive-feedback-d1/d4/d8`
  - Version hardware-realista relativa.
  - Control in-band.
- `member-formula-rate`
  - Baseline heuristica: `capacity / (members - 1)`.
  - No usa advisor completo.
- `max-rate-recovery`
  - Max rate con recovery.
  - Normalmente mucho overhead.
- `no-recovery-max-rate`
  - Control negativo.
  - Muestra por que recovery es necesario.

## 11. Campana Experimental

Manifest:

- `campaign-manifest.json`

Fases:

- A: Screening, 2,880 runs.
  - Exploratorio.
  - Sirve para descartar alphas y elegir fixed alpha.
- B-training: 1,120 runs.
  - Entrena configuraciones adaptive LHS.
- B-validation: 960 runs.
  - Valida top adaptive configs y selecciona oracle.
- C: 6,960 reports.
  - Principal held-out evaluation.
  - Incluye random-balanced seeds 26-55 y placements deterministas.
  - Esta es la evidencia confirmatoria principal.
- D: 1,200 reports.
  - Realistic feedback D1/D4/D8.
  - Payload 1,000.
- E: 480 reports.
  - Payload largo 10,000.
  - Robustez long-payload.

Dataset canonico final:

- `results/campaigns/final-corrected`
- Validacion:

```json
{
  "valid": true,
  "reports": 13600,
  "uniqueReports": 13600,
  "replacedReports": 3720,
  "removedSupersededReports": 3720,
  "phaseCounts": {
    "A": 2880,
    "B-training": 1120,
    "B-validation": 960,
    "C": 6960,
    "D": 1200,
    "E": 480
  },
  "violations": []
}
```

Correccion adaptive:

- `results/campaigns/adaptive-correction`
- 3,720 runs corregidas.
- 14 wall-clock timeouts en phase E para `adaptive-feedback-d4`.
- Estos timeouts se cuentan como completion failures, no se excluyen.

## 12. Resultados Clave

Confirmatory phase-policy summary actual (`analysis/final/tables/phase_policy_summary.csv`):

### Phase C: Held-out principal

- `advisor-overdrive-a1.05`
  - 1200/1200 completadas.
  - Win/tie/loss: 692/315/193.
  - Win rate: 57.67%.
  - Mean delta CCT: -25.50 ticks.
  - Median delta: -2 ticks.
  - Median relative delta: -1.90%.
- `selected-adaptive-oracle`
  - 1200/1200 completadas.
  - Win/tie/loss: 704/423/73.
  - Win rate: 58.67%.
  - Mean delta CCT: -33.62 ticks.
  - Median delta: -2 ticks.
  - Median relative delta: -2.51%.
- `per-source-lossless`
  - 1200/1200 completadas.
  - Practicamente empata con exact lossless.
- `member-formula-rate`
  - 1200/1200 completadas.
  - Mean delta positivo: peor en media.
- `max-rate-recovery`
  - 480/480 completadas.
  - Peor en general: recovery overhead alto.
- `no-recovery-max-rate`
  - 72/480 completadas.
  - Control negativo, no sirve para completion.

Interpretacion:

- Fixed 1.05 overdrive y oracle pueden batir a exact lossless en bastantes escenarios.
- Las mejoras medianas son pequenas en porcentaje global, pero consistentes en muchos casos.
- Completion sigue siendo el filtro principal.

### Phase D: Realistic feedback

- `selected-adaptive-oracle`
  - 240/240 completadas.
  - Mean delta: -76.45 ticks.
  - Median relative: -4.04%.
- `adaptive-feedback-d1`
  - 240/240 completadas.
  - Mean delta: +5.55 ticks.
- `adaptive-feedback-d4`
  - 240/240 completadas.
  - Mean delta: -5.79 ticks.
  - Median delta 0.
- `adaptive-feedback-d8`
  - 240/240 completadas.
  - Mean delta: +2.39 ticks.

Interpretacion:

- El oracle tiene ventaja clara porque no paga control ni delay.
- Feedback realista pierde gran parte de esa ventaja.
- D4 fue seleccionado como mejor feedback overall, pero no es una victoria fuerte en D.

### Phase E: Payload largo 10,000

- `advisor-overdrive-a1.05`
  - 120/120 completadas.
  - Win/tie/loss: 77/15/28.
  - Win rate: 64.17%.
  - Mean delta CCT: -277.72 ticks.
  - Median delta: -47.5 ticks.
  - Median relative: -1.47%.
- `adaptive-feedback-d4`
  - 106/120 completadas.
  - 14 wall-clock timeouts.
  - Se interpreta como inestabilidad/coste excesivo en escenarios largos.
- `per-source-lossless`
  - 120/120 completadas.
  - Muy cerca de exact lossless.

Interpretacion:

- Fixed 1.05 overdrive parece robusto en payload largo.
- Feedback D4 puede entrar en recovery/control work excesivo en long-payload stress.
- Los 14 timeouts son evidencia importante, no ruido.

## 13. Forensic Runs

Se seleccionaron 80 runs full-telemetry:

- 40 focal cases.
- 40 exact-lossless baselines emparejadas.

Archivo de seleccion:

- `results/campaigns/final-corrected/forensic-80.jsonl`
- `results/campaigns/final-corrected/forensic-80-selection.json`

Output pesado:

- `results/campaigns/forensic-80/reports.jsonl`
- Tamano aproximado: 5.8 GB.

Categorias:

- best-fixed-overdrive: 8
- worst-fixed-overdrive: 8
- best-corrected-feedback: 6
- worst-corrected-feedback: 6
- near-tie: 4
- extreme-recovery-tail: 4
- per-source-divergence: 2
- no-recovery-control: 2

Cobertura:

- Capacities: 5, 10, 20.
- Buffers: 8, 16, 32, 64, 128.
- Placements: adversarial-shared-uplink, global-spread, pod-compact, pod-spread, rack-compact, random-balanced.
- Perfiles: 12, 16, 2, 2-2-2-2, 2-2-4-8, 4-8, 8-8.
- 4 focal cases long-payload.

Importante:

- 3 forensic reports fueron truncados explicitamente por tamano de telemetry.
- Esto esta marcado con `summary.telemetryTruncated = true`.
- No invalida el resumen; evita que Node caiga intentando serializar cadenas JSON enormes.

## 14. Problemas Importantes Que Ya Se Corrigieron

### 14.1 Adaptive heredaba lossless admission

Bug metodologico:

- Adaptive/oracle/feedback se clonaban desde exact-lossless y heredaban `losslessAdmissionControl=true`.
- Eso hacia que adaptive pareciera mejor/mas lossless de lo que debia.

Correccion:

- `adaptive-correction-runner.js`
- Repite 3,720 adaptive runs afectadas.
- Fuerza:

```text
losslessAdmissionControl = false
enableRecovery = true
admissionMode = lossy-fifo-with-selective-recovery
```

Resultado:

- `results/campaigns/adaptive-correction/validation.json` valido.
- `results/campaigns/final-corrected` reemplaza los 3,720 reports obsoletos.

### 14.2 Runs phase E patologicas congelaban la campana

Problema:

- Algunas runs adaptive-feedback phase E tardaban horas.

Correccion:

- `barc-sim-core.js` soporta `maxWallClockMs`.
- `adaptive-correction-runner.js` acepta:
  - `--max-wall-clock-ms`
  - `--max-wall-clock-ms-e`
- Si se excede el guardrail, se marca:
  - `summary.timeoutReason = "wall-clock-timeout"`
  - `summary.activeAtEnd = true`

Interpretacion:

- Timeouts cuentan como failures/inestabilidad.

### 14.3 Full telemetry podia crear JSON demasiado grande

Problema:

- Forensic full telemetry produjo `RangeError: Invalid string length` al hacer `JSON.stringify`.

Correccion:

- `campaign-runner.js` ahora intenta serializar full telemetry y, si es demasiado grande, trunca arrays enormes con metadata `telemetryTruncation`.
- `generate-research-report.py` lee forensic reports en streaming para no cargar 5.8 GB en RAM.
- `campaign-runner.js` ya no intenta `analyzeCampaign` automatico sobre forensic full telemetry.

## 15. PDF Final

Archivo:

- `output/pdf/barc_multicast_adaptive_research_report.pdf`

Estado:

- Version V2 ampliada con seccion pedagogica:
  - `Methodology and Switch Mechanics Primer`
  - `Scenario Generation, Seeds, and Profiles`
  - `Switch Drop State and Selective Recovery`
  - `Rate Advisor, Lossless Rate, and Fixed Overdrive`
  - `Adaptive Oracle and Tuning Procedure`
- 43 paginas.
- Renderizado y validado:

```json
{
  "valid": true,
  "pages": 43,
  "renderedPages": 43,
  "violations": []
}
```

QA visual:

- Contact sheets revisados manualmente.
- No se vieron clipping, solapes ni paginas vacias.

Comando para regenerar sin rerunear experimentos:

```powershell
$python = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'

& $python final-research-analysis.py `
  --campaign results/campaigns/final-corrected `
  --forensic results/campaigns/forensic-80 `
  --out analysis/final `
  --bootstrap-samples 10000

& $python generate-research-report.py `
  --campaign results/campaigns/final-corrected `
  --analysis analysis/final `
  --forensic results/campaigns/forensic-80 `
  --out output/pdf/barc_multicast_adaptive_research_report.pdf

& $python verify-research-report.py `
  --pdf output/pdf/barc_multicast_adaptive_research_report.pdf `
  --out tmp/pdfs/barc-report-qa
```

## 16. Comandos Utiles

Node:

```powershell
$node = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
```

Python:

```powershell
$python = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
```

Tests:

```powershell
& $node barc-sim-tests.js
& $node campaign-tests.js
& $node research-pipeline-tests.js
& $node --check campaign-runner.js
& $python -m py_compile final-research-analysis.py generate-research-report.py verify-research-report.py
```

Validar dataset final:

```powershell
Get-Content results/campaigns/final-corrected/validation.json
Get-Content results/campaigns/final-corrected/canonical-validation.json
Get-Content results/campaigns/final-corrected/selections.json
```

Contar reports:

```powershell
(Get-Content results/campaigns/final-corrected/reports.jsonl | Measure-Object -Line).Lines
(Get-Content results/campaigns/forensic-80/reports.jsonl | Measure-Object -Line).Lines
```

Ojo: `results/campaigns/forensic-80/reports.jsonl` pesa ~5.8 GB. No usar parsers que lo lean completo con `readFileSync` o `Get-Content | ConvertFrom-Json` entero si no es necesario.

## 17. Archivos Clave

Core:

- `barc-sim-core.js`
  - Simulacion determinista.
  - Forwarding multicast/unicast.
  - Queues, drops, recovery, adaptive, reports.

UI:

- `emulator.html`
- `emulator-app.js`

Runners:

- `experiment-runner.js`
  - Politicas base y advisor.
- `campaign-runner.js`
  - Campana A-E y forensic.
- `adaptive-correction-runner.js`
  - Correccion adaptive.
- `build-corrected-dataset.js`
  - Construye dataset canonico final.
- `select-forensic-cases.js`
  - Selecciona 80 forensic cases.

Analisis/reporting:

- `campaign-analysis.js`
- `final-research-analysis.py`
- `generate-research-report.py`
- `verify-research-report.py`

Docs:

- `BARC_EMULATOR_RESEARCH_GUIDE.md`
- `CAMPAIGN_README.md`
- `CORRECTED_RESEARCH_PIPELINE.md`
- `CONTEXT.md` (este archivo)

## 18. Datos Y Artefactos

Campana original:

- `results/campaigns/full`

Correccion adaptive:

- `results/campaigns/adaptive-correction`

Dataset canonico:

- `results/campaigns/final-corrected`

Forensic full telemetry:

- `results/campaigns/forensic-80`

Analisis final:

- `analysis/final/statistics.json`
- `analysis/final/report_data.json`
- `analysis/final/tables/`
- `analysis/final/figures/`

PDF:

- `output/pdf/barc_multicast_adaptive_research_report.pdf`
- `output/pdf/report_source.md`

Render QA:

- `tmp/pdfs/barc-report-qa/verification.json`
- `tmp/pdfs/barc-report-qa/contact-*.png`

## 19. Interpretacion Actual Para Research

Lectura conservadora:

1. Exact lossless es el baseline seguro.
2. Fixed 1.05 overdrive es el candidato mas prometedor actualmente:
   - Completa en C y E.
   - Mejora CCT en muchas paired runs.
   - Mantiene recovery controlado comparado con max-rate.
3. Adaptive oracle muestra que con telemetria ideal hay margen de mejora.
4. Adaptive feedback realista pierde bastante de esa ventaja por:
   - delay,
   - control traffic,
   - cola compartida,
   - recovery/control interactions.
5. En payload largo, `adaptive-feedback-d4` tiene 14 timeouts:
   - evidencia de inestabilidad/coste excesivo,
   - no se debe ocultar.
6. No-recovery-max-rate confirma que sin recovery la completion no sirve bajo congestion.
7. Per-source lossless puede ser util en perfiles heterogeneos, pero no transforma radicalmente los resultados.

## 20. Limitaciones Actuales

- Topologia pequena fija de 16 hosts.
- No hay calibracion realista de ns/us, solo ticks.
- No hay trafico background/tenants externos.
- No se modelan detalles de pipeline real de switch/NIC.
- Advisor y exact lossless son idealizados.
- Oracle no es implementable tal cual.
- BARC control plane esta offloaded/asumido.
- Source replay buffer es conceptual en hardware; en el emulador `packetStore` simplifica esto.
- No se modelan ACKs tipo TCP; el recovery es implicitamente acked cuando el repair llega y se completa.

## 21. Siguientes Pasos Recomendados

### 21.1 Cientificos/metodologicos

- Escalar topologia:
  - mas pods,
  - mas racks,
  - mas hosts,
  - k-ary Clos configurable.
- Repetir campana con mas seeds y diferentes placements reales.
- Introducir arrival offsets realistas basados en compute completion, pero contando offset en CCT.
- Evaluar si fixed overdrive alpha deberia depender de profile/capacity/buffer.
- Investigar policy selector simple:
  - input: profile, capacity, buffer, placement/advisor bottleneck features.
  - output: lossless vs fixed overdrive vs feedback.
- Disenar feedback mas local:
  - evitar que todo pase por CA/root si genera retardo/control overhead.
- Investigar memory budget real de switch:
  - cuantos pending reports por puerto/switch se necesitan,
  - que pasa con overflow de metadata,
  - compresion/coalescing mas agresivo.
- Investigar source replay buffer:
  - cuanto debe conservar un host,
  - TTL de packet ids,
  - interaccion con payload largo.

### 21.2 Ingenieria del emulador

- Parametrizar topologia en vez de 16 hosts fijos.
- Exponer configuracion de memory budget para switch drop obligations.
- Exportar timeline resumido sin guardar 5.8 GB full telemetry.
- Crear un modo forensic streaming/chunked:
  - NDJSON por ledger,
  - no un unico report JSON gigante.
- Mejorar visualizaciones del PDF:
  - heatmaps por layer/link,
  - timelines de forensic cases,
  - ECDFs de CCT/FCT.
- Crear notebook de analisis reproducible.
- Preparar scripts de limpieza para outputs enormes.

## 22. Cosas Que No Conviene Hacer Sin Pensarlo

- No rerunear `results/campaigns/full` salvo que sea necesario; es costoso.
- No mezclar resultados adaptive viejos con corrected adaptive.
- No usar `results/campaigns/full` como dataset final para conclusiones: usar `final-corrected`.
- No excluir timeouts de phase E: cuentan como fallos.
- No interpretar oracle como hardware implementable.
- No leer `results/campaigns/forensic-80/reports.jsonl` entero en memoria.
- No asumir que switch guarda payload completo; eso contradice la narrativa actual.
- No decir que overdrive 1.05 es 1.05%; es 105% del lossless rate, un 5% de overdrive.

## 23. Preguntas Que El Informe V2 Ya Responde

El PDF actual ya incluye explicacion para:

- Que es un seed y que controla.
- Como se colocan los hosts por colectivo.
- Que perfiles/tamanos/colectivos varian.
- Que guarda un switch al dropear.
- Cuando se manda un drop-report.
- Si el report es lista o paquete por paquete.
- Que memoria conceptual necesita el switch.
- Como se calcula lossless rate.
- Como se calcula overdrive.
- Que informacion necesita el advisor.
- Como se elige el oracle.
- Por que oracle puede perder contra lossless.

Seccion relevante en PDF:

- `7. Methodology and Switch Mechanics Primer`
- `8. Scenario Generation, Seeds, and Profiles`
- `9. Switch Drop State and Selective Recovery`
- `10. Rate Advisor, Lossless Rate, and Fixed Overdrive`
- `11. Adaptive Oracle and Tuning Procedure`

## 24. Estado De Git/Trabajo

Hay cambios locales importantes no necesariamente commiteados. No revertir cambios de usuario. En la ultima inspeccion habia muchos archivos nuevos/modificados, incluyendo:

- `barc-sim-core.js`
- `campaign-runner.js`
- `campaign-analysis.js`
- `campaign-tests.js`
- `adaptive-correction-runner.js`
- `build-corrected-dataset.js`
- `final-research-analysis.py`
- `generate-research-report.py`
- `verify-research-report.py`
- `select-forensic-cases.js`
- datasets en `results/`
- artefactos en `analysis/`, `output/`, `tmp/`

Si se va a versionar, revisar primero tamanos. Probablemente no conviene commitear `results/campaigns/forensic-80/reports.jsonl` de 5.8 GB.

## 25. Resumen Ejecutivo Para Otro Chat

Tenemos un emulador de multicast collectives sobre una topologia Clos/fat-tree fija, usando BARC como control plane asumido. Implementamos forwarding stateless, drops por buffer/capacity, recovery selectivo con drop reports diferidos, repair-to-switch y repair-subtree, una sola FIFO por puerto, rates fraccionarios y politicas lossless/overdrive/adaptive.

Se ejecuto una campana final corregida de 13,600 reports. Se corrigio un bug donde adaptive heredaba lossless admission. El dataset final valido esta en `results/campaigns/final-corrected`.

Resultados principales:

- Fixed overdrive 1.05 y adaptive oracle pueden mejorar CCT frente a exact lossless en bastantes escenarios manteniendo completion.
- Fixed overdrive 1.05 es el candidato mas prometedor y robusto actual.
- Adaptive feedback realista pierde mucha ventaja del oracle por delay/control traffic y tiene 14 timeouts en payload largo.
- No-recovery-max-rate falla como control negativo.
- Completion manda; timeouts cuentan como fallos.

El PDF final V2 esta en `output/pdf/barc_multicast_adaptive_research_report.pdf`, tiene 43 paginas y esta validado visualmente. Incluye una seccion pedagogica nueva que explica seeds, scenarios, switch recovery, advisor, overdrive y oracle.

## 26. Repo De Implementacion Real AF_XDP/XDP: `XDP_REC_10`

Ademas del emulador y la campana experimental, ahora hay un repositorio Git con una implementacion real muy temprana de smart-switch/recovery sobre AF_XDP/XDP.

Ruta local accesible desde este workspace:

- `C:\Users\user\Desktop\WEB\data\XDP_REC_10`

Ruta Linux original mencionada en el handoff previo:

- `/home/nextnet/XDP_10`

Estado Git observado desde este entorno:

```text
branch: main
remote: origin https://github.com/DavidRicoCodes/XDP_REC_10.git
HEAD: 30812f2 Add XDP 10Gbps recovery projects
status: limpio frente a origin/main
```

Nota importante de reproducibilidad:

- En este entorno Windows se ha hecho inspeccion estatica del codigo.
- El handoff previo indica que en la maquina Linux se comprobo compilacion de `xdp_recovery_10`, `xdp_recovery_10_long` y `speed_sink`, y que ambas variantes arrancaban aunque no habia interfaces `sw-p0`, `sw-p1`, `sw-uplink0`, `sw-uplink1` disponibles para validar trafico real.
- Si otro chat trabaja desde Linux, debe repetir `make clean && make` dentro de cada variante y validar interfaces antes de sacar conclusiones de rendimiento.

### 26.1. Objetivo Del Repo

El repo implementa un switch en user space usando AF_XDP y un programa eBPF/XDP minimo. La idea original era probar recovery a 10 Gbps manteniendo copia/historial de paquetes para poder retransmitirlos desde el propio switch.

Esto es distinto del diseno actual de investigacion:

- Implementacion actual del repo:
  - El switch encapsula paquetes con una cabecera propia de fiabilidad.
  - Asigna numeros de secuencia por puerto de salida.
  - Guarda referencias al frame completo en un `history_buffer`.
  - Si detecta un gap de secuencia, envia NACK.
  - Al recibir NACK, retransmite desde el historial del propio switch.

- Diseno actual del emulador/research:
  - El switch que dropea no guarda payload completo.
  - Guarda metadata minima del drop: origen, `originalPacketId`, switch, puerto afectado, hosts afectados, intento y tick.
  - Difiere un `drop-report` hasta que el origen acaba su emision original.
  - El origen retransmite al switch que dropeo.
  - Ese switch reenvia solo por el subarbol/puertos afectados.

Por tanto, el repo AF_XDP es una base de dataplane muy util, pero su mecanismo de recovery debe ser redisenado para alinearlo con el research final.

### 26.2. Estructura Del Repo

Archivos y directorios principales:

- `xdp_recovery_10/`
  - Variante corta, mas agresiva, orientada a rendimiento.
  - Tiene `mpsc_queue.h` separado.
  - Usa cache local de frames por hilo, spinlock global para pool de frames y una cola MPSC que espera activamente cuando esta llena.
  - Probablemente era el intento de empujar hacia 10 Gbps, pero tiene mayor riesgo de concurrencia/backpressure.

- `xdp_recovery_10_long/`
  - Variante mas larga y defensiva, marcada en logs como `Design-B`.
  - Tiene mas comprobaciones, counters atomicos, MPSC bounded no bloqueante, contadores de queue drops y TX drops.
  - Es la mejor candidata como base canonica para continuar.

- `setupinterfacesRS.sh`
  - Script para renombrar/configurar interfaces fisicas:
    - `sw-p0`
    - `sw-p1`
    - `sw-uplink0`
    - `sw-uplink1`
  - Asigna MACs con prefijo BARC tipo rack switch.

- `speed_sink.c`
  - Utilidad raw socket/promiscuous para escuchar una interfaz.
  - Mide Mbps/PPS.
  - Filtra especialmente EtherType `0x88B5`, aunque tambien puede contar IPv4.

- Binarios/objetos actualmente versionados:
  - `xdp_recovery_10/af_xdp_user`
  - `xdp_recovery_10/xdp_kern.o`
  - `xdp_recovery_10_long/af_xdp_user`
  - `xdp_recovery_10_long/xdp_kern.o`
  - `speed_sink`

Recomendacion de higiene Git:

- Anadir `.gitignore` para binarios y objetos (`af_xdp_user`, `*.o`, `speed_sink`, posibles logs).
- Mantener solo codigo fuente y scripts reproducibles.
- Anadir README con prerequisitos Linux, NICs, comandos de build, setup de interfaces y benchmark.

### 26.3. Programa eBPF/XDP Kernel

Archivo:

- `XDP_REC_10\xdp_recovery_10\xdp_kern.c`
- Mismo enfoque en `xdp_recovery_10_long\xdp_kern.c`

Funcion:

- Define un `BPF_MAP_TYPE_XSKMAP` llamado `xsks_map`.
- Usa `ctx->rx_queue_index` como clave.
- Si hay socket AF_XDP asociado a esa cola, retorna:

```c
bpf_redirect_map(&xsks_map, index, 0)
```

- Si no hay socket asociado, retorna `XDP_PASS`.

Lectura arquitectonica:

- El eBPF no implementa BARC.
- El eBPF no implementa multicast.
- El eBPF no implementa recovery.
- El eBPF solo mueve paquetes desde RX queue hacia AF_XDP de forma barata.
- Toda la inteligencia vive en user space.

Esto es bueno para iterar rapido, pero si el objetivo final es un smart switch real a alta velocidad, habra que decidir que partes deben quedarse en user space y cuales tendrian que migrar a eBPF, hardware offload, P4, switch ASIC, DPU o firmware.

### 26.4. Direccionamiento BARC En `common.h`

Archivo:

- `XDP_REC_10\xdp_recovery_10\common.h`
- `XDP_REC_10\xdp_recovery_10_long\common.h`

Tipos y EtherTypes definidos:

```c
#define ETH_P_CUSTOM_REL 0x88B5
#define ETH_P_NACK       0x9999
#define ETH_P_IP         0x0800

#define DEVICE_TYPE_HOST   0xAE
#define DEVICE_TYPE_RACK   0xEE
#define DEVICE_TYPE_FABRIC 0xFE
#define DEVICE_TYPE_SPINE  0xBE
```

Formato de direccion BARC simplificado:

```c
struct barc_addr {
    uint8_t type;
    uint8_t pod;
    uint8_t rack;
    uint8_t host;
    uint8_t pad1;
    uint8_t pad2;
} __attribute__((packed));
```

Interpretacion:

- La MAC se trata como direccion estructurada tipo BARC.
- `type` distingue host/rack/fabric/spine.
- `pod`, `rack` y `host` permiten decisiones locales de forwarding.
- Este formato coincide conceptualmente con el emulador: forwarding stateless a partir de campos de direccion, no FDB dinamica aprendida.

Cabecera de fiabilidad actual:

```c
struct custom_rel_header {
    uint32_t raw_data;
} __attribute__((packed));
```

Semantica actual:

- 16 bits altos: numero de secuencia.
- 16 bits bajos: EtherType original.
- Se inserta despues de la cabecera Ethernet.
- El EtherType externo pasa a `0x88B5`.

Limitacion:

- Esta cabecera identifica orden/secuencia por puerto, no `collectiveId`, `blockId`, `originalPacketId`, `sourceHost`, `affectedPorts`, etc.
- Para el diseno nuevo, esta cabecera no es suficiente.

### 26.5. Puertos Y Topologia Fisica Del Switch AF_XDP

Ambas variantes asumen cuatro puertos:

```text
sw-p0
sw-p1
sw-uplink0
sw-uplink1
```

Modelo implicito:

- `sw-p0` y `sw-p1` son downlinks a hosts.
- `sw-uplink0` y `sw-uplink1` son uplinks hacia fabric/spine.
- `my_config` se fija como rack switch:

```c
my_config.type = DEVICE_TYPE_RACK;
my_config.pod_id = 1;
my_config.rack_id = 1;
my_config.num_uplinks = 2;
```

Forwarding actual:

- Si el destino es un host dentro del mismo pod/rack:
  - `dst->host` decide puerto local `0` o `1`.
- Si no es destino local:
  - se calcula hash simple sobre MAC origen/destino.
  - se elige uplink `2 + (token % 2)`.

Lectura frente al emulador:

- Esto es una version muy reducida de un rack switch.
- No modela aun los 4 pods completos, 2 racks/pod y 16 hosts del emulador.
- No tiene awareness explicito de colectivos multicast.
- No hace replicacion multicast por varios puertos.
- No tiene CA/root logic ni phase scheduling.
- Es una base dataplane de un switch individual.

### 26.6. Modelo AF_XDP/UMEM

Constantes principales en la version `long`:

```c
#define NUM_PORTS 4
#define FRAME_SIZE 2048
#define FRAME_HEADROOM 256
#define NUM_FRAMES 262144
#define BATCH_SIZE 64
#define BUFFER_SIZE 32768
#define LOCAL_CACHE_SIZE 1024
#define LOCAL_REFILL_BULK 256
#define MPSC_QUEUE_SIZE 4096
#define MPSC_DRAIN_BUDGET 256
```

Estructuras relevantes:

- `port_state`
  - socket XSK
  - rings RX/TX/fill/completion
  - `history_buffer`
  - `next_tx_seq`
  - `expected_rx_seq`
  - cache local de frames
  - thread por puerto
  - counters atomicos

- `pending_pkt`
  - `addr`
  - `len`
  - En el diseno actual del repo apunta a frame completo en UMEM.

- `tx_work_item`
  - `addr`
  - `len`
  - `seq`
  - `type`

- `mpsc_queue`
  - cola entre threads de puertos.
  - en `long` es bounded y devuelve error si esta llena.

Modelo de threading:

- Un thread por puerto.
- Cada thread:
  - drena TX completions.
  - drena su cola MPSC inbound.
  - procesa RX ring.
  - rellena fill ring.
  - envia batch TX si corresponde.

### 26.7. Recovery Actual En El Repo

El recovery actual es de tipo NACK/retransmision local por secuencia.

Flujo de envio normal:

1. Llega paquete por RX.
2. Se decide puerto de salida con `get_output_port_barc`.
3. Si el puerto destino es otro thread, se encola `WORK_FORWARD_DATA`.
4. El thread propietario del puerto de salida encapsula:
   - mueve cabecera Ethernet para insertar 4 bytes.
   - cambia EtherType a `ETH_P_CUSTOM_REL` (`0x88B5`).
   - empaqueta `seq` y EtherType original.
5. Guarda el frame encapsulado en `history_buffer[seq % BUFFER_SIZE]`.
6. Transmite por TX ring.
7. Incrementa `next_tx_seq`.

Flujo de recepcion fiable:

1. Si llega EtherType `0x88B5`, se lee `custom_rel_header`.
2. Si es el primer paquete, se sincroniza `expected_rx_seq`.
3. Si `seq != expected_rx_seq` y `seq > expected_rx_seq`, genera NACK para el `expected_rx_seq`.
4. Si el paquete llega en orden:
   - incrementa `expected_rx_seq`.
   - decapsula.
   - restaura EtherType original.
   - forwardea el payload.

Flujo NACK:

1. NACK usa EtherType `0x9999`.
2. Payload:

```c
struct nack_payload {
    uint16_t missing_seq;
    uint16_t padding;
};
```

3. Al recibir NACK, llama a retransmitir `missing_seq`.
4. Retransmite desde `history_buffer`.

Punto critico:

- El switch actual guarda contenido del paquete en UMEM para retransmitir.
- El diseno nuevo pretende que el switch no guarde payload completo, solo metadata de drop.
- Por tanto, `history_buffer` debe dejar de ser el nucleo de recovery para multicast selective-repair.

### 26.8. Diferencias Entre `xdp_recovery_10` Y `xdp_recovery_10_long`

`xdp_recovery_10`:

- Variante mas corta.
- `mpsc_queue.h` separado.
- `MPSC_QUEUE_SIZE 8192`.
- `mpsc_queue_enqueue` hace `atomic_fetch_add` del head y luego espera activamente si el slot esta ocupado.
- Usa `pthread_spinlock_t global_stack_lock`.
- Contadores de stats son `uint64_t` normales.
- Si la cola se llena o el consumidor va lento, puede quedarse girando.
- Tiene menos contadores para entender drops internos.

Riesgos:

- Backpressure por spin puede quemar CPU y ocultar congestion real.
- Productores pueden quedarse bloqueados por consumidor lento.
- Menos instrumentacion de errores.
- Semantica de referencias de frames mas dificil de auditar.

`xdp_recovery_10_long`:

- Variante mas defensiva.
- MPSC integrada en el mismo archivo.
- `MPSC_QUEUE_SIZE 4096`.
- `mpsc_enqueue` comprueba `head - tail >= MPSC_QUEUE_SIZE` y devuelve error si esta llena.
- Counters atomicos:
  - `rx_pkts`
  - `tx_pkts`
  - `tx_completed`
  - `fill_submitted`
  - `nack_sent`
  - `retransmissions`
  - `q_enqueued`
  - `q_dequeued`
  - `q_dropped`
  - `tx_dropped`
- Usa `pthread_mutex_t global_free_lock` en vez de spinlock global.
- Tiene `INVALID_ADDR`.
- Tiene checks de refcount mas robustos.
- Tiene `thread_started` y cleanup mas ordenado.

Recomendacion actual:

- Usar `xdp_recovery_10_long` como base canonica funcional.
- Portar optimizaciones de `xdp_recovery_10` solo despues de tener tests y telemetria.
- No partir de la version corta para redisenar recovery salvo que el objetivo inmediato sea microbenchmark de rendimiento.

### 26.9. Como Encaja Con El Research Actual

El repo es util para convertir el emulador en prototipo real, pero hay que hacer una migracion conceptual:

En el emulador ya decidimos:

- BARC control plane offloaded:
  - registration
  - ABI
  - CA assignment
  - FDB/forwarding state inicial
- Una sola cola por puerto.
- Drop reports pequenos (`0.05` bloques en modelo).
- Data/repair de tamano completo (`1` bloque en modelo).
- Switch consciente de drops por interfaz.
- Reports diferidos hasta que el origen termina emision original.
- Repair desde origen al switch que dropeo.
- Subtree repair solo por puertos afectados.
- No repetir multicast global.

En el repo actual:

- No hay drop-report diferido.
- No hay `originalPacketId`.
- No hay `collectiveId`.
- No hay lista de hosts afectados.
- No hay coalescing de drops por `(sourceHost, originalPacketId, switchId, affectedPortKeys, attempt)`.
- No hay diferenciacion de paquetes:
  - `data-multicast`
  - `drop-report`
  - `repair-to-switch`
  - `repair-subtree`
  - `congestion-report`
  - `rate-update`
- No hay multicast partial-subtree.
- No hay adaptive feedback.
- No hay rate advisor o scheduler.
- No hay medicion CCT/FCT en dataplane real.

Por tanto, el trabajo futuro no es "optimizar el NACK actual", sino sustituirlo por el protocolo resultante del research.

### 26.10. Migracion Propuesta Del Repo A Selective Recovery

Plan conceptual para evolucionar `xdp_recovery_10_long`:

1. Elegir variante canonica.
   - Crear README.
   - Marcar `xdp_recovery_10_long` como base.
   - Mover la corta a `experimental/` o documentarla como fast prototype.

2. Separar modulos.
   - `dataplane_xsk.c/h`
   - `barc_addr.c/h`
   - `switch_forwarding.c/h`
   - `recovery_protocol.c/h`
   - `telemetry.c/h`
   - `packet_format.h`

3. Cambiar cabecera de fiabilidad.
   - Sustituir `custom_rel_header` de 4 bytes por una cabecera mas rica.
   - Campos candidatos:
     - `packetType`
     - `collectiveId`
     - `sourceHost`
     - `originalPacketId`
     - `blockId`
     - `attempt`
     - `targetSwitchId`
     - flags
   - Mantener alineacion y cuidado de endianess.

4. Sustituir NACK por drop-report.
   - Al no poder encolar/enviar por un puerto afectado:
     - registrar metadata del drop.
     - no copiar payload en switch.
     - coalesce pending report.
   - El report debe indicar paquete original y puertos/hosts afectados.

5. Implementar origen con replay buffer.
   - En el emulador, `packetStore` vive logicamente en el origen.
   - En hardware real, el origen necesita un replay buffer temporal.
   - Este buffer si guarda payload completo, porque el origen es quien reenvia.
   - Pregunta abierta: tamanos y eviction policy del replay buffer.

6. Implementar `repair-to-switch`.
   - El origen envia unicast al switch que dropeo.
   - El switch al recibirlo no lo trata como data normal.
   - Lo transforma en `repair-subtree` hacia puertos afectados.

7. Implementar partial-subtree replication.
   - El switch debe poder emitir por un subconjunto de puertos.
   - Para rack switch simple:
     - puertos host locales (`sw-p0`, `sw-p1`)
     - uplinks si el subarbol afectado esta arriba
   - Para fabric/spine real, hay que mapear affected hosts a output ports.

8. Mantener una unica cola por puerto.
   - No crear colas separadas de data/control/repair.
   - Los work items pueden tener tipos, pero al final compiten por el mismo TX ring.
   - Si el TX ring no cabe, report/repair no debe expulsar data ya encolada.

9. Anadir telemetria compatible con el emulador.
   - Drops por puerto.
   - Reports pendientes/enviados.
   - Repairs enviados.
   - Latencias:
     - drop -> report
     - report -> repair-to-switch
     - repair -> delivery
   - Per-interface utilization.
   - CCT/FCT deberia medirse desde hosts o con timestamping.

10. Solo despues optimizar.
    - Reintroducir spinlocks/caches agressivas si hay tests.
    - Benchmark con `speed_sink` o trafico generado controlado.
    - Perf/ftrace/bpftrace para hotspots.

### 26.11. Mapping Del Emulador Al Repo AF_XDP

| Concepto Emulador | Estado En Repo Actual | Cambio Necesario |
| --- | --- | --- |
| BARC stateless unicast | Parcial, por MAC estructurada | Generalizar a todos los roles/pods |
| Multicast collective | No implementado explicitamente | Replicacion por output-set/subarbol |
| Drop ledger | No existe como ledger conceptual | Crear metadata por drop |
| Pending drop reports | No existe | Crear pending map/queue |
| Drop report diferido | No existe | Gate por source availability o senal equivalente |
| Source packetStore | No existe como origen | Implementar replay buffer en host/origen |
| Repair-to-switch | No existe | Nuevo packet type |
| Repair-subtree | No existe | Nuevo packet type + output set |
| NACK por seq | Si existe | Retirar o dejar solo para pruebas |
| Switch copia payload | Si, `history_buffer` | Evitar en diseno final |
| Una FIFO por puerto | Aproximado con TX ring + MPSC | Mantener sin prioridad estricta |
| Adaptive feedback | No existe | Futuro, tras selective recovery |

### 26.12. Riesgos Tecnicos Del Repo

Riesgos de protocolo:

- Secuencia es por egress port, no por flujo/colectivo/origen.
- `expected_rx_seq` por puerto puede romperse si hay multiples fuentes o reordenamiento valido.
- NACK solo pide una secuencia, no un conjunto de drops.
- NACK actual no identifica correctamente subarbol afectado.
- Broadcast MAC en NACK (`FF:FF:FF:FF:FF:FF`) es demasiado bruto para el diseno final.
- No hay limite conceptual de intentos comparable a `maxRepairAttempts`.

Riesgos de memoria:

- `history_buffer` guarda referencias a frames completos.
- `BUFFER_SIZE=32768` por puerto puede ser insuficiente o excesivo segun trafico.
- El modelo no captura aun "metadata-only switch memory".
- El replay buffer correcto deberia moverse al origen, no al switch intermedio.

Riesgos de concurrencia:

- Variante corta usa spin en enqueue cuando slot ocupado.
- Referencias de frames requieren auditoria muy cuidadosa.
- TX ring full puede causar `tx_dropped`; hay que definir si eso equivale a drop ledger/recovery.
- Queue drops internas (`q_dropped`) deben convertirse en eventos de congestion/drop reportables.

Riesgos de medicion:

- `speed_sink` mide trafico pero no CCT/FCT.
- Faltan timestamps por `originalPacketId`.
- Faltan logs estructurados JSON/CSV.
- Faltan counters equivalentes a los del emulador.

Riesgos de despliegue:

- Requiere Linux, libbpf/libelf/clang/gcc, permisos root/CAP_NET_ADMIN, NIC compatible AF_XDP.
- Interfaces deben existir y estar renombradas.
- Las MACs BARC del script son especificas del montaje actual.

### 26.13. Comandos Utiles Del Repo

Desde Linux, ruta original:

```bash
cd /home/nextnet/XDP_10
git status --short --branch
git log -1 --oneline
```

Compilar variante corta:

```bash
cd /home/nextnet/XDP_10/xdp_recovery_10
make clean
make
```

Compilar variante long:

```bash
cd /home/nextnet/XDP_10/xdp_recovery_10_long
make clean
make
```

Configurar interfaces del rack switch:

```bash
cd /home/nextnet/XDP_10
sudo ./setupinterfacesRS.sh
ip link show sw-p0
ip link show sw-p1
ip link show sw-uplink0
ip link show sw-uplink1
```

Ejecutar switch:

```bash
cd /home/nextnet/XDP_10/xdp_recovery_10_long
sudo ./af_xdp_user
```

Medir trafico:

```bash
cd /home/nextnet/XDP_10
gcc -O2 speed_sink.c -o speed_sink
sudo ./speed_sink sw-p0
```

Desde Windows, ruta inspeccionada:

```powershell
cd C:\Users\user\Desktop\WEB\data\XDP_REC_10
git status --short --branch
rg --files
```

### 26.14. Recomendacion Actual Para La Linea De Research

Recomendacion tecnica:

1. Mantener el emulador como fuente de verdad para diseno de politicas.
2. Usar `xdp_recovery_10_long` como base de prototipo real.
3. No intentar "parchear" el NACK actual hasta que este definida la cabecera selective-recovery.
4. Implementar primero metadata-only drop ledger y packet types.
5. Implementar replay buffer en origen.
6. Implementar partial-subtree repair.
7. Solo despues anadir adaptive feedback.

Recomendacion de narrativa research:

- El repo AF_XDP demuestra que existe una ruta plausible hacia dataplane real.
- La version antigua copiaba payloads en switches para retransmitir.
- El resultado del research propone una arquitectura mas eficiente:
  - switches guardan obligaciones de reparacion, no payload;
  - origen conserva/reproduce payload;
  - reparacion se dirige al switch que dropeo;
  - el switch solo repara ramas afectadas.
- Esta es una diferencia importante y defendible frente a enfoques tipo TCP/NACK tradicional.

### 26.15. Preguntas Pendientes Para Hardware Real

Todavia hay decisiones abiertas:

- Donde vive exactamente el replay buffer del origen:
  - NIC?
  - host userspace?
  - driver?
  - DPU?
- Como sabe un switch real que `sourceAvailableForRepair` es cierto:
  - marcador de fin de flujo?
  - credit/scheduler?
  - inferencia por ultimo bloque?
  - senal explicita de source idle?
- Cuanta memoria de metadata necesita cada switch:
  - por colectivo?
  - por puerto?
  - por tick?
  - por intento?
- Como codificar `affectedHosts`/`affectedPortKeys` de forma compacta:
  - bitmask por puertos?
  - bitmap por hosts?
  - Bloom/compressed set?
  - tree token?
- Como evitar que drop reports se pierdan indefinidamente sin crear TCP:
  - retry limitado?
  - periodic summary?
  - host/CA reconciliation?
- Como mapear advisor/offline scheduling a control real:
  - CA central?
  - spine coordinators?
  - host scheduler?
  - offline placement planner?

Estas preguntas deben quedar separadas de los resultados del emulador: el emulador valida politicas y tradeoffs; el repo AF_XDP es el siguiente paso para probar viabilidad dataplane.
