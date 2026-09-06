# Validación

## 2026-09-06 06:37 UTC: ocho mejoras verificadas

La [lista de mejoras y resultados](IMPROVEMENTS.md) conserva todo el alcance solicitado. El análisis contable, dashboard, procesamiento por cambios y selección por partido están en el servicio paper. La comparación de cuatro modelos y la calibración por liga son retrospectivas: mejora pequeña y todavía peor que las cuotas de cierre. La investigación maker conserva el resultado insuficiente de sus escenarios; no se añade al arranque.

Pasaron 117 pruebas en quince archivos, typecheck, build y comprobaciones pertinentes de modelos, replay, colector público y navegador. Las 5.570 predicciones Poisson originales siguen idénticas por SHA-256. Los informes HTML nuevos se revisaron en escritorio, móvil y teclado; el dashboard desplegado ya pasó esas comprobaciones y axe sin infracciones. Fuentes, periodos, costes, parámetros y hashes están en los manifiestos vinculados.

A las 06:37:46 UTC, systemd seguía `active/running`, PID 2133963, cero reinicios automáticos desde las 06:01:32 UTC; `/health` devolvió 200. La cuenta estaba conectada, sin parada ni errores, con evaluación reciente, once posiciones y once fills, sin liquidaciones. Las bibliotecas de investigación adicionales no requieren reiniciar ese proceso; no promueven modelos ni envían órdenes. El próximo seguimiento de 24 horas aún no había vencido en esta comprobación.

## 2026-09-06 06:10 UTC: análisis y procesamiento desplegados

La unidad permanece activa, reanudada en paper tras cargar `botpoly-v4-batch-analysis` a las 06:01:32 UTC. Conserva once posiciones y once fills, sin liquidaciones. Las pruebas del dashboard se repitieron contra la API desplegada en escritorio, móvil y teclado, con cero infracciones axe. Pasaron 115 pruebas, typecheck y build. El análisis incluye desglose contable, referencia de efectivo, concentración y calidad de entrada; los treinta minutos históricos sin datos siguen identificados como ausentes. [Detalle y límites](IMPROVEMENTS.md) y [evidencia con hashes y medidas](evidence/batch-processing-20260906.json).

## 2026-09-06 04:42 UTC: servicio permanente activo

El bloqueo de permisos anterior quedó resuelto mediante sudo autenticado. **`botpoly.service` está activo y habilitado**, iniciado el 2026-09-06 a las **04:39:37 UTC**, con PID 2100147 en `/system.slice/botpoly.service`, `Result=success` y cero reinicios automáticos durante esta comprobación. Es la unidad permanente instalada, con una única instancia y escucha en `127.0.0.1:3001`. `/health` devuelve 200 y la API sin sesión devuelve 401. No se probó un reinicio completo del servidor.

`pnpm paper:resume` fue aceptado tras conciliación y sincronización. Se conservó `.runtime/paper-observation.sqlite`, capital inicial US$1.000 simulado, las once posiciones con exactamente las mismas cantidades y once fills; no hay órdenes pendientes ni liquidaciones observadas. `stop=null`, `connected=true` y `errors=0`. Las evaluaciones acumuladas crecieron de **398.365** al reanudar a **402.765** en el informe de las **04:42:12.509 UTC**. Esa muestra tenía 5.000 mercados inspeccionados, 200 seleccionados/sincronizados, 100 de fútbol y 76 pronósticos, con las seis fuentes verificadas.

El informe conserva capital valorado **US$990,87866**, PnL neto/no realizado **−US$9,12134**, realizado US$0, comisiones simuladas US$2,67237 y gas contabilizado US$0. Son valores de esa captura; las pérdidas y el historial anteriores permanecen intactos. Artefactos locales: `reports/paper-service-verification-20260906/` (HTML, JSON, CSV, SVG, PNG y manifiesto). SHA-256 de `result.json`: `9c0c0b8d79cd0a6c16b92ddbded3257c5c636e8fcca569743f6d8759802b9efb`; los hashes del resto de archivos están en su manifiesto.

Telegram confirmó el nuevo aviso de arranque (`telegram:sent:deployment:1788669578714`) y el texto, PNG y HTML del informe administrativo (`telegram:sent:service-verification-20260906`, `:photo`, `:document`), con outbox vacía. Se encoló mediante la cola de informes existente para verificar generación y envío dentro de la unidad; **no se simuló un `/report` recibido de un usuario**. Se revisó el PNG generado. Los IDs horarios 03/04 persistieron sin repetir la hora 04 tras este arranque.

El origen histórico sigue en **2026-09-05T06:42:23.706Z**. Los seguimientos 24/72 h y el informe diario continúan programados; sus próximos envíos aún no han vencido en esta comprobación. Live sigue desactivado. El servicio se deja funcionando; el estado detenido y el bloqueo descritos en la sección siguiente son históricos.

## 2026-09-06 04:27 UTC: verificación temporal de fútbol y evidencia

**Estado histórico a las 04:27 UTC: servicio instalado y habilitado, pero inactivo; puerto 3001 libre.** La instancia temporal de `pnpm start` se detuvo ordenadamente. El despliegue persistente quedó pendiente entonces: `sudo -n systemctl start botpoly.service` requería contraseña y `systemctl --no-ask-password start botpoly.service` devolvía acceso denegado. Los permisos amplios del cliente no concedían privilegios del sistema. No se usaron unidades ajenas ni se creó un servicio alternativo.

### Código y pruebas

Se conservaron los cambios publicados del modelo, motor, feed, dashboard y evaluación. `83b128f` cierra la revisión pendiente de `authorizeLive`: se reprodujo con datos de prueba la aceptación de un informe sin cobertura y checksum correcto. Ahora se exigen presencia/tipos, números finitos, conteos enteros seguros, un único ensayo de evaluación, intervalos completos y ordenados, arrays reales y fills válidos/no duplicados. La regresión cubre fills ausentes, cadenas numéricas, desbordamiento al parsear JSON, revisión incompleta y cambio de bytes tras aprobar. No carga claves reales ni hace red; no ocurrió ninguna activación real.

| Comprobación del cierre | Evidencia / resultado |
|---|---|
| `pnpm test` | **109 pruebas correctas en 12 archivos**, incluida la regresión de evidencia malformada |
| `pnpm typecheck` | Backend y dashboard correctos |
| `pnpm build` | Backend y dashboard construidos |
| `pnpm exec vitest run src/engine/live.test.ts` | 5 pruebas de frontera correctas, con datos de prueba y ejecutores simulados |
| Arranque paper con `.runtime/no-live-import.mjs` | Guardia `registerHooks` activa; `/health` correcto; sin importar `src/engine/live` ni `src/services/trading-service` |
| Backtest con la misma guardia | `reports/signer-closure-synthetic-20260906/`: fixture **sintético**, exploratorio y `liveEligible=false` |
| Evaluación offline con manifiesto versionado | `reports/football-closure-replay-20260906/`: 5.570 predicciones idénticas byte a byte al CSV anterior; 21 CSV fuente y métricas/configuración verificados |
| Chromium, escritorio 1440 px y móvil 390 px | Secciones, teclado, foco visible y tabla desplazable; sin desbordamiento general ni errores JavaScript; axe: cero infracciones detectadas |
| SQLite antes de arrancar | `integrity_check=ok`; copia consistente mediante `Connection.backup`, también verificada |

La suite cubre reservas/límites compartidos, Kelly, una apuesta por partido/reinicio, ventana previa, salida del 10% neto, parciales, incertidumbre, resolución ganadora/perdedora/fraccionaria e idempotencia. Comprueba identidad y tiempos de libros, eliminación de niveles, reconexión y lotes que omiten tokens conservando vecinos válidos. El modelo tiene checks de CSV, aliases, muestra, exclusión del futuro y caché verificable. Se mantienen las pruebas de arbitraje, Telegram, autenticación y origen histórico del seguimiento.

Logs locales: `.runtime/closure-tests-20260906.log`, `.runtime/closure-typecheck-20260906.log`, `.runtime/closure-build-20260906.log`, `.runtime/closure-football-replay-20260906.log` y `.runtime/closure-backtest-20260906.log`. La revisión visual reutilizó el script anterior mediante `/tmp/playwright-test-botpoly-closure.cjs`; se inspeccionaron `/tmp/botpoly-desktop-closure.png`, `/tmp/botpoly-mobile-closure.png` y `/tmp/botpoly-positions-mobile-closure.png`. No se capturaron contraseñas ni se instalaron dependencias. El importador PMXT no cambió; no se repitieron sus pruebas Python.

La **integración heredada** de las 03:30 UTC terminó con 74/74 pruebas y 8/8 archivos correctos, pero `.runtime/integration-20260906.log` contiene el rechazo **“CLOB messages are not supported anymore”** del feed antiguo `ws-live-data.polymarket.com`. Algunas pruebas toleran no recibir datos dentro del timeout. Ese verde no demuestra compatibilidad del feed anterior; no se añadieron capturas silenciosas para ocultarlo. El runtime usa `@polymarket/client` 0.9.0 y su stream actual, comprobado en paper.

### Cuenta preservada y actividad real

Se comprobó la ausencia de otra instancia, la unidad y el puerto antes de iniciar. Entorno: Node **24.20.0**, pnpm **10.32.1**, modo `paper`, base **`.runtime/paper-observation.sqlite`**, capital inicial **US$1.000 simulados**. La base anterior de US$50 no se tocó. La nueva copia consistente es `.runtime/backups/paper-observation-20260906T041533Z.sqlite`; no se restauró ni se sustituyó la base activa.

La instancia temporal arrancó a las **04:16:24.860 UTC**. Tras conciliación y sincronización, `pnpm paper:resume` fue aceptado por el control normal. No se editaron `stop`, `errors` o `connected` a mano. El registro de las 04:25:32 UTC (`.runtime/closure-operational-20260906.json`) mostró `stop=null`, `errors=0`, datos actuales y evaluaciones creciendo. Tras detener el proceso se confirmó que las once posiciones conservaban exactamente las cantidades anteriores, con once órdenes `filled`, sin órdenes inciertas ni nuevas apuestas de esos partidos.

| Medida | Comprobación |
|---|---:|
| Evaluaciones acumuladas al reanudar (04:19 UTC) | 379.798 |
| Evaluaciones acumuladas al cierre (04:27 UTC) | 397.570 |
| Compras / fills confirmados paper | 11 / 11 |
| Posiciones abiertas / reservas | 11 / 11 |
| Ventas / liquidaciones | 0 / 0 |
| Efectivo | US$901,46423 |
| Reserva restante | US$0,203958 |
| Capital valorado al cierre | US$990,49746 |
| PnL neto / no realizado | **−US$9,50254** |
| PnL realizado | US$0 |
| Comisiones simuladas / gas contabilizado | US$2,67237 / US$0 |

Son pérdidas no realizadas de la simulación, con comisiones y valoración de salida. Tras la parada esa valoración queda histórica; no equivale a una cotización fresca futura. El gas paper modela 300.000 unidades supuestas, multiplicador 1,5 y precios públicos: no es gasto real ni estimación de transacción live. Gas ×3 sobre las mismas ejecuciones mantiene aquí −US$9,50254 porque aún no hay gas contabilizado; no prueba insensibilidad de futuras liquidaciones al gas.

Muestra de cobertura a las **04:25:32 UTC**: 5.000 inspeccionados, 200 seleccionados, 100 de fútbol, 76 con pronóstico, 197 con ambos libros frescos al preparar, cero mercados retenidos adicionales y cero fallos de descubrimiento/metadatos. Las seis fuentes tenían resultados verificados. Son cifras de esa muestra, no constantes ni estado actual de un proceso detenido. La implementación conserva posiciones fuera del cupo y archiva muestras de profundidad, no todos los eventos.

Los contadores finales por estrategia son 39.106 evaluaciones de fútbol y 33.269 de YES/NO; se añadieron después de iniciar la cuenta y no suman el histórico completo. Se conservaron 186.205 rechazos por ventaja neta insuficiente, 33.185 por valoración obsoleta, 3.638 por historial de fútbol ausente/insuficiente/caducado y 1.983 por partido ya reservado, entre otros. No se relajaron límites para generar actividad.

SIGTERM terminó ordenadamente a las **04:27:12.833 UTC**, persistiendo la parada que requiere reanudación autorizada. `pnpm start` finalizó con código 0, la unidad quedó `inactive/dead`, `MainPID=0`, y `ss` confirmó el puerto libre. Los campos persistidos de conexión pueden reflejar la última observación; la unidad, el proceso y el puerto acreditan que el bot está detenido.

El informe final está en `reports/paper-actual/` (HTML, JSON, CSV y manifiesto), con procedencia, periodos, configuración, costes y limitaciones. SHA-256 de su `result.json` a este cierre: `834ec2554c3ee5938db4e49d3edac513beea773c08ec0ad3b8ca6cc911809165`. Ese directorio se actualizará al volver a ejecutar; los informes horarios y de verificación anteriores se conservan. No se publica toda `.runtime/` ni `reports/`.

### Telegram y seguimiento

Se verificaron los registros `telegram:sent:hourly:2026-09-06T03` y `:photo` anteriores, y sus equivalentes **T04** del nuevo arranque. `flush` solo los escribe tras HTTP correcto y `ok=true` de Telegram. A las 04:25 UTC la outbox estaba vacía. Los archivos están en `reports/paper-hourly-2026-09-06T03/` y `reports/paper-hourly-2026-09-06T04/`. Esto acredita dos horas UTC con estado/PNG aceptados por la API, **no dos horas completas de ejecución continua ni lectura humana**; la hora 04 se envió al arrancar dentro de esa hora.

Permanecen las confirmaciones anteriores `verification:20260906:paper`, `:chart` y `:model`. No se fabricaron updates de usuario: `/report` concurrente tiene pruebas simuladas, pero no se afirma que llegara un `/report` real en esta comprobación. Gráficas horarias e informe diario completo permanecen programados; no se adelantó el reloj para acreditarlos.

El arranque operativo comprobó `experimentStartedAt=1788590543706`, **2026-09-05T06:42:23.706Z**, derivado del historial de la cuenta. Los seguimientos corresponden al **2026-09-06 06:42:23.706 UTC (24 h)** y **2026-09-08 06:42:23.706 UTC (72 h)**. Todavía no se observaron sus envíos ni un nuevo ciclo diario a medianoche. Requieren que el proceso funcione; al cierre está detenido.

### Evidencia predictiva y pendiente operativo

Se publican el [resumen de fútbol](evidence/football-20260906.json) y su [manifiesto](evidence/football-20260906-manifest.json), contrastados con los originales locales y reproducidos con los mismos CSV. Desarrollo 2023-07-01–2025-07-01; evaluación 2025-07-01–2026-07-01, con límites finales exclusivos. El modelo obtuvo Brier **0,593861** y log-loss **0,996456** en 2.001 predicciones de evaluación; las cuotas de cierre sin margen obtuvieron **0,579763 / 0,974479**, mejores en ambas métricas. Se conservan calibración y casos excluidos. Calidad predictiva y ejecución paper son evidencias distintas; ninguna acredita rentabilidad live. Fuentes, parámetros, alcance V1/90 minutos y reproducción: [FOOTBALL.md](FOOTBALL.md).

**Intervención pendiente en aquel corte, resuelta a las 04:39 UTC:** iniciar la unidad permanente con privilegios legítimos. La instancia temporal ya estaba detenida. Comandos de arranque y reanudación en este servidor:

```bash
cd /home/gabo/portfolio/projects/38-hibraim/botpoly/Polymarket-bot
export PATH="$PWD/.runtime/node24/bin:$PATH"
sudo systemctl start botpoly.service
pnpm paper:resume
```

Si la reanudación se deniega por frescura, esperar la sincronización y revisar el motivo; no editar SQLite ni saltarse el control. Después comprobar `systemctl is-active botpoly.service`, `pnpm paper:status`, crecimiento de evaluaciones y Telegram. No iniciar otro `pnpm start` mientras la unidad ocupe el puerto. No hace falta instalar paquetes, rotar credenciales ni activar live.

Live mantiene activación explícita y evidencia revisada vinculada a ambas estrategias. La revisión operativa independiente y evidencia prospectiva suficiente siguen pendientes; las pruebas del adaptador son simuladas. **No se enviaron órdenes ni transacciones reales.** Este tramo temporal no acreditaba funcionamiento persistente; el arranque posterior de la unidad se documenta al principio de este archivo.

## Historial de validación — 2026-09-05

## Corrección del seguimiento paper durante días

La versión posterior al despliegue inicial corrige la selección de mercados y el bloqueo permanente de costes en paper. La comprobación pública seleccionó 20 mercados estándar; los libros con datos vigentes pasaron al cálculo de ventaja neta con comisiones y gas modelado. Se conservaron los rechazos por falta de rentabilidad, tamaño o frescura.

- Suite actual: **76 pruebas correctas**, incluidos cinco días de reloj simulado, fills con costes, archivo comprimido, reinicio y contadores persistentes; tipos y builds correctos.
- Las ejecuciones paper y la profundidad consumida se conservan en SQLite. Se probó que una consulta repetida del mismo hash y un reinicio no permiten duplicar fills ni reutilizar esa liquidez.
- Los costes modelados mantienen `gasVerified=false` y no autorizan live. Se prueban precios caducados, parámetros inválidos y libros de ejecución obsoletos.
- Los informes HTML requieren sesión y se abren con CSP restrictiva y sandbox. JSON y CSV siguen siendo descargables.
- La vista de seguimiento pasó Chromium + axe a 1440 y 320 px sin infracciones detectadas, desbordamientos ni errores JavaScript. Se comprobó la apertura autenticada del informe y su lectura sin internet. Las capturas y resultados locales están en `.browser-check/paper-*`.
- La nueva ejecución conserva US$1.000 simulados en `.runtime/paper-observation.sqlite`; el experimento anterior de US$50 se mantiene en su archivo original. El reinicio conserva las nuevas estadísticas y paradas.
- Comprobación inicial: 2.960 libros evaluados, 1.024 archivados, cero operaciones y PnL cero. Son minutos de observación real, **no cinco días de resultados de mercado**. Los cinco días de la prueba automatizada utilizan datos sintéticos.

El informe continuo está en `reports/paper-actual/report.html` y se actualiza cada cinco minutos. Se conserva una muestra de esta ejecución en `docs/evidence/paper-observation/`. No se reescribieron los backtests históricos siguientes.

Entorno: Node 24.20.0, pnpm 10.32.1; instalación con scripts desactivados. **No se enviaron órdenes ni transacciones reales.** Las comprobaciones iniciales siguientes preceden a la configuración de Telegram; después se activó con las credenciales privadas del usuario para las alertas e informes autorizados.

## Comprobaciones del despliegue inicial

| Comprobación | Resultado |
|---|---|
| `pnpm test` | 70 pruebas correctas, 6 archivos |
| `pnpm typecheck` | Backend y dashboard correctos |
| `pnpm build` | Backend y dashboard construidos |
| `python scripts/research/test_import_pmxt.py` con PyArrow 23.0.1 | 2 pruebas correctas |
| Integración heredada, APIs públicas | Primera ejecución: 65/74; las 9 fallidas se corrigieron y los dos archivos afectados pasaron 19/19 al repetirlos |
| Chromium + axe, WCAG 2 A/AA y 2.1 AA | Sin infracciones detectadas en 1440, 1024, 768 y 320 px ni en las cinco vistas |
| Controles del dashboard | Sesión, conexión WebSocket, edición de capital, pausa, cancelación, reanudación y foco por teclado verificados |
| `pnpm audit` | 0 críticos/altos/moderados; 1 bajo pendiente en elliptic, sin parche publicado |
| `botpoly.service` | Instalado, habilitado y activo; cero reinicios automáticos durante la verificación |
| Acceso al servicio instalado | `/health` correcto, API privada sin sesión devuelve 401, escucha solo en 127.0.0.1:3001 |

La integración corrigió la paginación del cliente público: la primera página no debe invocar `from(undefined)`. Los otros ocho fallos procedían del RPC Polygon antiguo; se verificó un RPC público alternativo y quedó configurable con `POLYGON_TEST_RPC`. Las pruebas no se convirtieron en éxitos mediante captura silenciosa de errores.

El motor se probó con reservas simultáneas, dos conexiones SQLite, duplicados, reinicios, pérdidas no realizadas, día UTC, profundidad ausente, rechazo de una pata, timeout y conciliación. Una fusión incierta se concilia sin reenviarla; tanto una confirmación posterior como un recibo fallido contabilizan gas una sola vez. Editar el presupuesto no altera efectivo ni PnL. Las pruebas de seguridad deniegan HTTP/WebSocket sin sesión y comandos antiguos, validan origen y autorización privada de Telegram, y preservan deduplicación y reintentos.

Las verificaciones visuales no detectaron desbordamiento horizontal ni errores JavaScript. La edición temporal de presupuesto de US$50 a US$75 mantuvo efectivo en US$50 y PnL en cero; se restauró US$50. Las capturas locales y resultados están en `.browser-check/`, excluidos de Git. Los controles automatizados de accesibilidad no sustituyen una revisión completa con tecnologías de asistencia.

## Informes entregados

Todos comparan límites originales aproximados, riesgo mejorado y efectivo, con periodos cronológicos separados y 18 ensayos registrados. Capital inicial: US$1.000; semilla: 42. Cada carpeta incluye HTML autónomo, JSON completo y CSV. El resultado siguiente corresponde al periodo de evaluación de **Riesgo mejorado**.

| Datos | Cobertura | Fills | PnL neto | Conclusión |
|---|---|---:|---:|---|
| [Fixture sintético](evidence/demo/report.html) | 121 libros, 2 minutos | 16 | +US$6,42888 | Exploratorio: valida el simulador; no demuestra beneficios reales |
| [Captura oficial](evidence/public-sample/report.html) | 80 libros, 20 mercados, unos 19 segundos | 0 | US$0 | Insuficiente: costes/metadatos y resolución temporal no permiten validar ejecución |
| [Extracto PMXT](evidence/pmxt-excerpt/report.html) | 1.994 estados, un mercado, unos 8 segundos | 0 | US$0 | Insuficiente: etiquetas históricas y costes sin verificar; entradas bloqueadas |

La evaluación sintética descuenta US$1,19112 de comisiones y US$0,18 de gas. Estos costes son parámetros del escenario sintético. No representan una cotización o gasto real.

Huella SHA-256 del código compartido de estrategia, riesgo, contabilidad y simulación usado en los tres informes:

```text
d553e50a0c980728a68779d08a14b2bd6fa78b8f63466eb35a4abcb13eb277aa
```

Los JSON incluyen esa huella, el checksum del dataset, procedencia, configuración, escenarios, resultados completos y limitaciones. Los ensayos anteriores se conservan en `reports/trials.jsonl`; los informes finales locales están en `reports/demo-final`, `reports/public-sample-final` y `reports/pmxt-excerpt-final`.

## Reproducción

Con el entorno de `INIT.md`, `pnpm backtest:demo` reproduce la demostración. Para los datasets reales, los argumentos exactos están en `fixtures/public-sample-command.json` y `fixtures/pmxt-excerpt-command.json`. Se pueden ejecutar sin copiar la lista de mercados:

```bash
pnpm exec node --input-type=module -e 'import {readFileSync} from "node:fs"; import {execFileSync} from "node:child_process"; execFileSync(process.execPath,["--import","tsx","src/research/backtest-cli.ts",...JSON.parse(readFileSync("fixtures/public-sample-command.json","utf8"))],{stdio:"inherit"})'
```

Antes del comando equivalente de PMXT, convierte el extracto:

```bash
pnpm data:import --input fixtures/pmxt/excerpt.parquet --mapping fixtures/pmxt/mapping.json --out data/pmxt-excerpt.jsonl --python .runtime/parquet-venv/bin/python
```

Después sustituye el nombre del archivo de argumentos por `fixtures/pmxt-excerpt-command.json`. Si ya existen datasets o informes, usa otro destino; no se sobrescriben ensayos. La instalación del entorno Python está documentada en `INIT.md`.

## Estado y límites

La configuración del despliegue inicial fue **paper**, capital US$50 y acceso privado en `127.0.0.1:3001`; la nueva ejecución de US$1.000 se detalla al principio de este documento. La unidad systemd y su instalador están en `deploy/`. El servicio del sistema quedó instalado y habilitado el 2026-09-05 a las 06:04 UTC. Se repitió la comprobación del dashboard contra ese servicio: las cuatro anchuras, las cinco vistas y los controles pasaron; la simulación inicial quedó reanudada con US$50. El arranque del equipo completo no se probó.

Telegram se activó posteriormente con el token y chat privados configurados por el usuario. La contraseña local está en `.dashboard-password`, con permisos 0600; no se publica.

**Live permanece bloqueado.** La evidencia entregada es insuficiente y el adaptador solo tiene pruebas de frontera simuladas. Deben revisarse de forma independiente firmas, recibos, comisiones efectivas, heartbeat y estimación previa de gas. Esta última puede fallar sin posiciones existentes y bloquear entradas. Más detalle en [seguridad e investigación](SECURITY-AND-RESEARCH.md).
