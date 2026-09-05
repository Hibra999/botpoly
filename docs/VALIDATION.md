# Validación — 2026-09-05

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
