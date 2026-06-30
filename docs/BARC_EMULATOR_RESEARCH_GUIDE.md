# BARC Datacenter Emulator - Research Guide

Este documento describe la version research-grade del emulador. La idea central es mantener BARC como sustrato ya provisionado y concentrar el emulador en lo que queremos estudiar: forwarding stateless, multicast colectivo, congestion, drops observables, hot spots, metricas de completion time y la base necesaria para recovery por unicast.

## 1. Objetivo De La Tool

El emulador modela un Clos fat-tree fijo de tres niveles con `k=4`:

- 4 Spine Switches, llamados `SS0` a `SS3`.
- 8 Fabric Switches, llamados `FS_p_i`, donde `p` es el pod e `i` es el fabric switch dentro del pod.
- 8 Rack Switches, llamados `RS_p_i`.
- 16 hosts, llamados `H_p_i`.

Cada host puede pertenecer a uno de 4 colectivos:

- `0`: red
- `1`: green
- `2`: blue
- `3`: orange

Un colectivo representa un closed host group. Cualquier miembro puede emitir bloques multicast hacia los demas miembros del mismo colectivo. La red replica los bloques dentro del fabric.

El objetivo del emulador no es simular el control plane completo de BARC. El objetivo es estudiar el plano de datos una vez que BARC ya ha dejado preparada la red.

## 2. Que Asumimos Que Ya Existe

Estas partes se dan por hechas y no se implementan como protocolo dinamico:

- BARC address claiming.
- Asignacion de ABI a switches.
- Asignacion de direcciones de host.
- Asignacion de Collective Addresses, CAs.
- Registro multicast.
- Construccion de FDB/egress vectors.
- Resolucion de conflictos de direcciones.
- Mensajes BARC Inquiry/Proposal.
- Mensajes exactos Ethernet/BARC, EtherType, subtype y formato binario.
- Tiempo de convergencia del control plane.
- MMRP/MRP.

Esto queda registrado tambien dentro de cada reporte JSON, en el campo `assumptions`.

La razon es que para este research queremos estudiar el comportamiento de trafico sobre un sustrato BARC ya configurado. Implementar el handshake de BARC mezclaria el problema de control plane con el problema que nos interesa: donde se congestiona la red, que drops ocurren, a quien afectan y que coste tendria recuperarlos.

## 3. Que Si Implementamos

La tool si implementa estas piezas:

- Topologia Clos fat-tree `k=4`.
- Colectivos de hosts.
- CAs preconfiguradas por colectivo.
- Multicast stateless basado en CA/egress state precomputado.
- Unicast stateless minimo para futuros repairs.
- Recovery automatico diferido: drop reports, repairs al switch que dropeo y multicast parcial por subarbol.
- Paquetes con identificador estable.
- Sequence numbers por fuente y colectivo.
- Buffers por puerto.
- Capacidad por puerto y tick.
- Drops por limite de buffer.
- Drop ledger estructurado.
- Control ledger, repair ledger y recovery latencies.
- Rate advisor y spine heatmap advisor para analisis.
- Event log.
- Heatmap temporal de utilizacion de enlaces.
- FCT por fuente-destino.
- CCT por host y colectivo.
- Batch runner reproducible con `seed`.
- Export JSON y CSV.

## 4. Archivos Principales

### `emulator.html`

Es el shell visual. Contiene:

- Barra de controles.
- Sliders de rates por colectivo.
- Canvas.
- Batch runner.
- Botones de exportacion.

No contiene ya la logica principal de simulacion. Carga:

```html
<script src="./barc-sim-core.js"></script>
<script src="./emulator-app.js"></script>
```

### `barc-sim-core.js`

Es el motor determinista. No depende del canvas. Puede usarse desde el navegador o desde Node.js.

Contiene:

- `BARCResearchSim`
- `SimNode`
- `Port`
- builders de topologia
- forwarding multicast
- forwarding unicast
- colas
- drops
- metricas
- batch/headless API
- exportadores CSV

### `emulator-app.js`

Es el puente entre el motor y la UI:

- Lee botones y sliders.
- Asigna colores a hosts.
- Ejecuta ticks visuales.
- Dibuja hosts, switches, enlaces, paquetes y drops.
- Llama al batch runner.
- Descarga JSON/CSV.

## 5. Modelo De Trafico

La unidad basica de trafico es un `block`. En la UI se interpreta como 100 MB por bloque, siguiendo el comportamiento previo de la herramienta.

Cada host activo tiene:

- `pending`: bloques que aun debe inyectar.
- `active`: si esta emitiendo o no.
- `completed`: bloques recibidos de otros hosts.
- `receivedStats`: bloques recibidos por fuente.
- `fctStats`: tick en que se completo la recepcion de una fuente concreta.

Cada tick:

1. Se entregan los paquetes que estaban en vuelo desde el tick anterior.
2. Los hosts activos inyectan hasta `tenantRates[color]` bloques.
3. Se liberan drop reports pendientes si el origen ya termino de emitir trafico original.
4. Se liberan repairs pendientes si el puerto del origen tiene espacio.
5. Cada puerto transmite hasta `capacity` bloques equivalentes.
6. Los bloques que no caben en el buffer de un puerto se dropean.
7. Se registra utilizacion de enlaces.
8. Se actualiza el progreso de modo secuencial si aplica.

## 6. Paquetes Y IDs

Cada paquete multicast tiene un ID de este estilo:

```text
red:H_0_0:187
```

Significa:

- colectivo `red`
- fuente `H_0_0`
- sequence number `187`

Campos principales de un paquete:

- `id`: identificador unico logico del bloque.
- `kind`: `data-multicast`, `drop-report`, `repair-to-switch` o `repair-subtree`.
- `sizeBlocks`: coste en bloques equivalentes; data/repair usan `1`, drop reports usan `0.05` por defecto.
- `colorIndex`: indice del colectivo.
- `collectiveId`: nombre del colectivo.
- `caId`: CA preconfigurada.
- `sourceId`: host fuente logico.
- `seqNo`: sequence number de esa fuente.
- `direction`: `up`, `down` o `unicast`.
- `createdTick`: tick de creacion.
- `intendedReceivers`: hosts que deberian recibir el bloque.
- `targetHostId`: destino si es unicast.
- `originalPacketId`: paquete multicast original si es repair.

## 7. Multicast Stateless

Cada colectivo tiene una CA preconfigurada:

```text
red    -> CA_RED_SS0
green  -> CA_GREEN_SS1
blue   -> CA_BLUE_SS2
orange -> CA_ORANGE_SS3
```

Cada CA tiene un root/spine implicito:

- red usa `SS0`
- green usa `SS1`
- blue usa `SS2`
- orange usa `SS3`

El motor precomputa reachability bottom-up segun la colocacion de hosts. Para cada puerto descendente sabe cuantos miembros de cada colectivo hay debajo. Esto funciona como una FDB/egress vector ya instalada.

Cuando un switch recibe un multicast:

- Si el paquete viene `up`, replica hacia miembros locales debajo del switch y, si hay miembros fuera de ese subarbol, continua subiendo.
- Si el paquete viene `down`, replica solo hacia puertos descendentes que tengan miembros del colectivo.
- En un `SS`, replica hacia pods que contienen miembros.

Esto modela la semantica de multicast preconfigurado sin simular los mensajes de registro.

## 8. Unicast Stateless Minimo

El core incluye `enqueueUnicastRepair(sourceNodeId, targetHostId, originalPacket)`.

Ejemplo:

```js
sim.enqueueUnicastRepair('SS0', 'H_0_1', {
  id: 'red:H_0_0:0',
  colorIndex: 0,
  collectiveId: 'red',
  caId: 'CA_RED_SS0',
  sourceId: 'H_0_0',
  seqNo: 0
});
```

Esto crea un repair unicast compatible con la API previa. El paquete mantiene `sourceId = H_0_0`, porque semanticamente repara un bloque emitido por `H_0_0`.

La ruta unicast se calcula desde la direccion destino/topologia, no desde una tabla dinamica:

- `SS`: baja al pod del host destino.
- `FS`: si esta en el pod destino, baja al rack destino; si no, sube a spine.
- `RS`: si esta en el rack destino, baja al host; si no, sube al fabric.
- `Host`: sube a su rack switch.

La API se mantiene para pruebas manuales. El recovery automatico usa internamente `drop-report`, `repair-to-switch` y `repair-subtree`.

## 8.1 Recovery Diferido

Cuando un puerto dropea data o repair, el emulador registra el drop inmediatamente y crea un `pendingDropReport`. Ese report no entra en red hasta que el host origen tiene `pending === 0` y `active === false`.

Una vez el origen recibe el report, agenda el repair localmente. El repair solo entra en la unica `queue` normal del puerto cuando hay espacio, de modo que no expulsa data ya encolada. Despues viaja en unicast hasta el switch que dropeo; ese switch reenvia solamente por los puertos afectados mediante `repair-subtree`.

No hay colas separadas para data, control y repair. La unica diferencia es `sizeBlocks`: un `drop-report` consume red pero muy poco.

## 9. Buffers, Capacidad Y Drops

Cada puerto tiene:

- `queue`: buffer persistente.
- `capacity`: bloques equivalentes que puede transmitir por tick.
- `bufferLimit`: maximo numero de bloques equivalentes esperando en cola.

Si un paquete intenta entrar en un puerto cuyo buffer ya esta lleno, se dropea y se escribe una entrada en `dropLedger`.

Esto reemplaza el modelo anterior, donde se procesaba todo el queue instantaneamente en un tick y se descartaba lo que no entraba en la capacidad del tick. El nuevo modelo separa:

- congestion por acumulacion de cola
- transmision por capacidad
- drop por buffer limitado

Es mas util para estudiar completion time, porque permite distinguir latencia por cola de perdida real.

## 10. Drop Ledger

El drop ledger es el registro estructurado de perdidas. Cada drop genera una entrada como esta:

```json
{
  "id": "drop-1",
  "tick": 1,
  "reason": "buffer_limit",
  "switchId": "H_0_0",
  "switchType": "Host",
  "portId": "pU",
  "portKey": "H_0_0.pU",
  "direction": "up",
  "packetId": "red:H_0_0:4",
  "packetKind": "data-multicast",
  "collectiveId": "red",
  "caId": "CA_RED_SS0",
  "colorIndex": 0,
  "sourceHost": "H_0_0",
  "seqNo": 4,
  "targetHostId": null,
  "affectedHosts": ["H_0_1", "H_0_2", "H_0_3"],
  "affectedCount": 3,
  "queueDepth": 4,
  "queueBlocks": 4,
  "packetSizeBlocks": 1,
  "pendingReportId": "report-1",
  "capacity": 4,
  "bufferLimit": 4
}
```

Interpretacion:

- `tick`: cuando se produjo la perdida.
- `switchId`: nodo donde estaba el puerto saturado.
- `portKey`: interfaz exacta.
- `packetId`: bloque perdido.
- `sourceHost`: host que genero el bloque.
- `seqNo`: numero de secuencia dentro de esa fuente.
- `affectedHosts`: hosts que dejaran de recibir ese bloque si no hay recovery.
- `affectedCount`: cardinalidad de `affectedHosts`.
- `queueDepth`: profundidad del queue en el momento del drop.
- `queueBlocks`: ocupacion en bloques equivalentes.
- `packetSizeBlocks`: coste del paquete dropeado.
- `pendingReportId`: report asociado, si recovery esta activo.
- `reason`: causa del drop. Ahora mismo la mas comun es `buffer_limit`.

El campo mas importante para recovery futuro es `affectedHosts`: permite construir repairs unicast selectivos.

## 11. Event Log

El JSON completo tambien incluye `eventLog`. Contiene eventos como:

- `inject`
- `enqueue`
- `forward`
- `arrive`
- `deliver`
- `drop`
- `drop-report-send`
- `repair-pending-source`
- `repair-inject`
- `repair-arrive-switch`
- `duplicate-delivery`

El event log sirve para reconstruir una run paso a paso. Para analisis mas agregado, normalmente es mas comodo empezar por:

- `summary`
- `collectives`
- `hostStats`
- `dropLedger`
- `dropsByInterface`
- `hotLinks`

## 12. Metricas Principales

### FCT

Flow Completion Time entre fuente y receptor.

En el reporte aparece dentro de:

```json
hostStats[].breakdown[].fctTicks
```

Ejemplo:

```json
{
  "sourceHost": "H_0_0",
  "received": 1000,
  "expected": 1000,
  "complete": true,
  "fctTicks": 312
}
```

Significa que ese host receptor completo los 1000 bloques enviados por `H_0_0` en el tick 312.

### CCT

Collective Completion Time. Es el maximo FCT necesario para que todos los miembros de un colectivo reciban todo lo esperado.

Aparece en:

```json
collectives[].cctTicks
```

Si hay drops no recuperados, `complete` sera `false` y `cctTicks` sera `null`.

### Drops Por Interfaz

Aparece en:

```json
dropsByInterface
```

Ejemplo:

```json
{
  "RS_0_0.p0": 8,
  "RS_1_1.p0": 12
}
```

Esto identifica hotspots de perdida por interfaz.

### Hot Links

Aparece en:

```json
hotLinks
```

Cada link incluye:

- `maxPct`: maxima utilizacion observada.
- `maxBlocks`: maximo de bloques transmitidos en un tick.
- `hotTicks`: numero de ticks en que el link llego al 100% o mas de la capacidad configurada.
- `a`, `b`: extremos del enlace.

### Link Utilization By Tick

Aparece en:

```json
linkUtilizationByTick
```

Es el heatmap temporal bruto. Para cada tick lista los enlaces que transmitieron trafico y su porcentaje de utilizacion.

### Recovery Latencies

Aparece en:

```json
recoveryLatencies
```

Cada entrada conecta un drop report con el repair correspondiente:

- `firstDropTick`: primer drop agrupado en el report.
- `reportSentTick`: cuando el report entra en red o se entrega localmente.
- `reportReceivedTick`: cuando el origen lo recibe.
- `repairQueuedTick`: cuando el repair entra en la cola normal del puerto.
- `repairSwitchTick`: cuando llega al switch que dropeo.
- `repairCompletedTick`: cuando todos los hosts afectados reciben el repair.

### Control And Repair Ledgers

`controlLedger` registra reports enviados, incluyendo self-reports locales en drops del propio puerto del host origen. `repairLedger` registra cada repair, sus hosts afectados, hosts reparados y ticks de progreso.

### Advisors

`rateAdvisor` estima carga por link para cada colectivo y recomienda un rate lossless por colectivo y uno uniforme combinado. El rate recomendado se conserva como decimal exacto; no se redondea artificialmente a un minimo de un bloque por tick.

`spineHeatmapAdvisor` agrega carga esperada por root/spine y propone phase offsets de colectivos. Es solo analitico: no cambia automaticamente el scheduling.

## 13. Uso Desde La UI

1. Abre `emulator.html` en el navegador.
2. En setup mode, haz click en hosts.
3. Selecciona el colectivo en el menu contextual.
4. Ajusta rates por color con los sliders.
5. Pulsa `Trigger All` o `Trigger Seq`.
6. Observa:
   - paquetes cuadrados para multicast
   - paquetes circulares para repair
   - diamantes claros para drop reports
   - X rojas para drops
   - porcentaje sobre enlaces activos
   - profundidad de cola en puertos, por ejemplo `p0:12`
7. Pasa el raton sobre un host para ver breakdown de recepcion.
8. Usa `Export JSON` para el reporte completo.
9. Usa `Export CSV` para summary, host stats y drops.

## 14. Batch Runner

El batch runner acepta un array JSON de escenarios.

Ejemplo:

```json
[
  {
    "scenarioName": "Balanced 1000MB/s All",
    "injectionMode": "all_at_once",
    "payloadBlocks": 1000,
    "capacity": 10,
    "bufferLimit": 64,
    "seed": 1,
    "enableRecovery": false,
    "rates": { "red": 10, "green": 10 },
    "hostColors": [0,0,0,0, 1,1,1,1, null,null,null,null, null,null,null,null]
  },
  {
    "scenarioName": "Sequential Choked Green",
    "injectionMode": "sequential",
    "payloadBlocks": 1000,
    "capacity": 10,
    "bufferLimit": 32,
    "seed": 2,
    "enableRecovery": true,
    "controlPacketBlocks": 0.05,
    "maxRepairAttempts": null,
    "dropReportRetryBaseTicks": 8,
    "dropReportRetryMaxTicks": 128,
    "rates": { "red": 10, "green": 3 },
    "hostColors": [0,0,0,0, 1,1,1,1, null,null,null,null, null,null,null,null]
  }
]
```

Campos:

- `scenarioName`: nombre de la run.
- `injectionMode`: `all_at_once` o `sequential`.
- `payloadBlocks`: bloques emitidos por cada host activo.
- `capacity`: bloques por tick que transmite cada puerto.
- `bufferLimit`: maximo de bloques en cola por puerto.
- `seed`: semilla determinista para orden secuencial y jitter visual de drops.
- `enableRecovery`: activa o desactiva recovery automatico.
- `controlPacketBlocks`: coste equivalente de cada drop report.
- `maxRepairAttempts`: limite opcional de reintentos. `null` deja que `maxTicks` actue como detector de livelock.
- `dropReportRetryBaseTicks`: timeout inicial antes de retransmitir un report sin confirmar.
- `dropReportRetryMaxTicks`: techo del backoff de retransmision.
- `rates.red`, `rates.green`, `rates.blue`, `rates.orange`: bloques/tick por host; admiten valores decimales.
- `hostColors`: array de 16 posiciones. Cada posicion corresponde a `H_0_0`, `H_0_1`, ..., `H_3_3`.

Al ejecutar batch se descargan:

- `batch_results_summary.csv`
- `batch_results_hosts.csv`
- `batch_results_drops.csv`
- `batch_results_recovery.csv`
- `batch_results_full.json`

## 15. Uso Headless Desde Node.js

Tambien se puede correr sin UI:

```js
const { BARCResearchSim } = require('./barc-sim-core.js');

const sim = new BARCResearchSim({
  capacity: 10,
  bufferLimit: 64,
  seed: 1
});

const report = sim.runScenario({
  scenarioName: 'headless-example',
  injectionMode: 'all_at_once',
  payloadBlocks: 100,
  capacity: 10,
  bufferLimit: 64,
  seed: 1,
  rates: { red: 10, green: 10 },
  hostColors: [
    0,0,0,0,
    1,1,1,1,
    null,null,null,null,
    null,null,null,null
  ]
});

console.log(report.summary);
console.log(report.dropsByInterface);
```

Salida esperada de alto nivel:

```json
{
  "ticks": 38,
  "totalInjected": 800,
  "totalRepairsInjected": 0,
  "totalDelivered": 2400,
  "totalDrops": 0,
  "activeAtEnd": false
}
```

Interpretacion:

- 8 hosts activos emitieron 100 bloques cada uno: `totalInjected = 800`.
- Cada colectivo tiene 4 hosts, por lo que cada bloque debe llegar a 3 receptores.
- Si no hay drops, `totalDelivered = 800 * 3 = 2400`.
- `activeAtEnd = false` indica que no quedan colas, paquetes en vuelo ni hosts activos.

## 16. Como Leer Un Reporte

Empieza por:

```json
summary
```

Si `totalDrops = 0` y los colectivos activos tienen `complete = true`, la run completo sin perdida.

Luego revisa:

```json
collectives
```

Aqui ves por colectivo:

- miembros
- CA
- root
- si completo
- CCT

Luego revisa:

```json
hostStats
```

Aqui ves si algun receptor concreto fallo para una fuente concreta.

Si hay drops, mira:

```json
dropsByInterface
dropLedger
```

`dropsByInterface` te da el hotspot agregado. `dropLedger` te da cada perdida con detalle suficiente para recovery.

Por ultimo mira:

```json
hotLinks
linkUtilizationByTick
```

Esto te dice si el problema fue perdida por buffer, saturacion sostenida, o bursts temporales.

## 17. Ejemplo De Run Con Drops

Config:

```json
{
  "scenarioName": "drop-smoke",
  "injectionMode": "all_at_once",
  "payloadBlocks": 20,
  "capacity": 4,
  "bufferLimit": 4,
  "seed": 1,
  "rates": { "red": 10, "green": 10 },
  "hostColors": [0,0,0,0, 1,1,1,1, null,null,null,null, null,null,null,null]
}
```

Que significa:

- Cada host activo intenta inyectar 10 bloques/tick.
- Cada puerto solo transmite 4 bloques/tick.
- Cada puerto solo puede almacenar 4 bloques.
- Por tanto, los puertos de host y algunos puertos uplink van a dropear.

Ejemplo de lectura:

```json
"dropsByInterface": {
  "H_0_0.pU": 12,
  "H_0_1.pU": 12,
  "RS_0_0.p0": 8
}
```

Interpretacion:

- `H_0_0.pU` dropeo 12 bloques al intentar subir al rack switch.
- `RS_0_0.p0` dropeo 8 bloques en uplink hacia fabric.
- Los drops en host uplink afectan a todos los otros miembros del colectivo.
- Los drops mas arriba suelen afectar a los miembros fuera del subarbol ya servido localmente.

## 18. Politicas De Recovery Y Rate Para Comparar

El recovery automatico implementado por defecto es:

```text
defer-until-source-tx-complete -> source-to-dropped-switch -> partial subtree multicast
```

Los reports son fiables sin introducir un ACK dedicado. El switch conserva cada perdida como una obligacion local y retransmite el `drop-report` con backoff hasta que observa regresar el correspondiente `repair-to-switch`. La llegada del repair funciona como confirmacion implicita. No se crea una conexion, una ventana de transporte ni se retransmite el flujo completo: el estado queda localizado por switch, paquete original y puerto afectado.

Los rates fraccionarios se implementan mediante packet pacing determinista. Los paquetes siguen siendo bloques completos; cada host acumula credito temporal y emite cuando corresponde. Las fuentes usan fases sub-tick distintas para evitar que un rate medio teoricamente lossless produzca microbursts sincronizados. Estas fases no son `startOffsetTicks` y no añaden espera deliberada al completion time.

Para el analisis completo conviene comparar:

- `no-recovery-max-rate`: maxima velocidad, recovery desactivado.
- `max-rate-recovery`: maxima velocidad con recovery fiable.
- `advisor-exact-lossless`: rate uniforme exacto `capacity / combinedMaxLoadFactor`.
- `advisor-overdrive-aX`: multiplica el rate lossless por alpha, limitado por la capacidad del host.
- `per-source-lossless`: rates max-min por fuente calculados sobre todos los enlaces recorridos.
- `adaptive-advisor-overdrive`: empieza en `1.20x` y aplica AIMD simplificado usando drops y ocupacion de colas.
- `member-formula-rate`: baseline `capacity / (members - 1)`.

El sweep de overdrive usa inicialmente:

```text
alpha = 1.05, 1.10, 1.20, 1.35, 1.50, 2.00
```

`per-source-lossless` usa progressive filling max-min. Incrementa simultaneamente los rates de las fuentes activas hasta saturar un enlace, congela las fuentes que usan ese bottleneck y continua con las demas. En colectivos all-to-all simetricos puede coincidir con el rate uniforme; su valor aparece en placements o cargas heterogeneas.

Las dos politicas lossless activan ademas admision topology-aware. Antes de inyectar cada bloque, el scheduler reserva la carga prevista en todos sus enlaces. Si el presupuesto instantaneo `min(capacity, bufferLimit)` de algun enlace se agotaria, la inyeccion se difiere. Si una replicacion interna encuentra una cola llena, queda stalled como backpressure y se reintenta sin contabilizar un drop. Esto representa un baseline lossless offline idealizado y garantiza que sus resultados no dependan de microbursts discretos.

`adaptive-advisor-overdrive` es por ahora un modelo de telemetria idealizada: el controlador observa drops y ocupacion maxima de cola sin modelar aun el retardo ni el formato de mensajes de telemetria. Debe interpretarse como cota de lo que podria conseguir un mecanismo fabric-aware, no como protocolo listo para hardware.

## 19. Limitaciones Actuales

- Topologia fija `k=4`.
- Cuatro colectivos fijos.
- Una CA por colectivo.
- No hay multiples CAs ni striping adaptativo aun.
- No hay ECN ni backpressure.
- No hay scheduler avanzado; ahora el puerto transmite FIFO.
- No hay colas separadas ni prioridad estricta para control/repair.
- La adaptacion automatica usa telemetria idealizada; falta modelar su retardo y coste de señalizacion.
- No hay ACK dedicado para recovery; el repair que vuelve al switch confirma implicitamente el report.
- No hay fallos de enlace/switch.
- No hay modelo fisico de latencia por distancia; un salto tarda un tick visual/logico.

Estas limitaciones son intencionales para mantener el primer core auditable.

## 20. Recomendacion De Proximas Iteraciones

Orden recomendado:

1. Validar escenarios base sin drops.
2. Generar escenarios con drops controlados.
3. Revisar si `affectedHosts` coincide con la intuicion del arbol multicast.
4. Crear un primer repair policy idealizado usando `dropLedger`.
5. Comparar CCT sin recovery vs con recovery.
6. Introducir multiples CAs por colectivo.
7. Evaluar placement de hosts.
8. Evaluar striping por CA.
9. Evaluar scheduling/fairness por puerto.
10. Escalar a `k` configurable.

## 21. Campana Experimental Por Fases

La campana completa esta definida en `campaign-manifest.json` y se ejecuta con `campaign-runner.js`. El manifiesto genera exactamente 13.600 runs:

```text
A screening       2880
B training        1120
B validation       960
C held-out        6960
D feedback        1200
E payload largo    480
```

Ejecucion completa:

```powershell
node campaign-runner.js --manifest campaign-manifest.json --phase all --out results/campaigns/full --resume
```

Ejecucion de una fase:

```powershell
node campaign-runner.js --manifest campaign-manifest.json --phase A --out results/campaigns/full --resume
```

Sharding reproducible:

```powershell
node campaign-runner.js --phase C --shard 1/4 --out results/campaigns/shard-1 --resume
node campaign-runner.js --phase C --shard 2/4 --out results/campaigns/shard-2 --resume
```

Los shards usan particion por indice estable. Su union contiene exactamente los escenarios de la fase sin solapamientos. Las fases dependientes necesitan el `selections.json` generado por las fases anteriores.

Validacion rapida de todo el pipeline:

```powershell
node campaign-runner.js --phase all --mini --out results/campaigns/mini --resume
```

El modo `aggregate` es el default de campana. Conserva contadores por interfaz, hot links, completion, recovery y telemetria adaptive, pero no serializa cada drop individual. El analisis genera:

- `paired-comparisons.csv`: una fila policy-vs-lossless por escenario pareado.
- `paired-summary.csv`: win/tie/loss, Wilson y bootstrap por estrato.
- `interfaces.csv`: drops por puerto y hot links.
- `adaptive.csv`: deteccion, llegada a CA, update y aplicacion.
- `selections.json`: alpha fijo, configuraciones adaptive y feedback seleccionados.
- `forensic-scenarios.jsonl`: runs que deben repetirse con ledgers completos.

Rerun forense:

```powershell
node campaign-runner.js --scenarioFile results/campaigns/full/forensic-scenarios.jsonl --out results/campaigns/forensic
```

### Adaptive Feedback Realista

`adaptive-feedback-d1`, `d4` y `d8` generan `congestion-report` cuando una cola cruza el high watermark. El report:

1. Ocupa 0,05 bloques en la FIFO normal.
2. Viaja por unicast stateless hasta la CA/root del colectivo.
3. Puede ser dropeado.
4. Espera 1, 4 u 8 ticks adicionales de procesamiento.
5. Provoca `rate-update` de 0,05 bloques hacia cada fuente.
6. El update tambien comparte cola y puede perderse.

El adaptive oracle sigue disponible como cota superior y observa congestion sin pagar mensajes ni delay.
