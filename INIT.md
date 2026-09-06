# Botpoly: instalación y operación

Bot con dashboard privado, arbitraje YES/NO y fútbol automático Poisson, contabilidad SQLite y simulación. Arranca en **paper**, con capital mínimo configurable de **US$50**; esta instalación conserva la cuenta de **US$1.000 simulados** del 2026-09-05. No hay evidencia suficiente para activar operaciones reales. Ver [fútbol y evidencia](docs/FOOTBALL.md), [seguridad y limitaciones](docs/SECURITY-AND-RESEARCH.md) y [validación](docs/VALIDATION.md).

## Entorno y dependencias

- Node **24.20.0** (`.nvmrc`, `.node-version`) y pnpm **10.32.1** (`packageManager`).
- Backend y `dashboard/` comparten `pnpm-workspace.yaml` y `pnpm-lock.yaml`.
- Los dos lockfiles npm originales se importaron antes de la actualización y permanecen en el historial Git (`9e28ae3`).
- Todos los scripts de dependencias están desactivados en `.npmrc`. `onlyBuiltDependencies` está vacío; esbuild funciona con su binario opcional precompilado. No ejecutar `approve-builds` sin revisar un paquete concreto.

```bash
nvm install
nvm use
corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile --ignore-scripts
pnpm audit
pnpm test
pnpm typecheck
pnpm build
pnpm auth:setup
pnpm start
```

Si tu distribución no incluye Corepack, instala pnpm 10.32.1 de acuerdo con su documentación. No se necesita ninguna clave privada para instalar, construir, recoger datos o hacer backtests.

En esta máquina Node 24 y pnpm están conservados en `.runtime/`, fuera de Git. Para usar los comandos directamente en una sesión de terminal:

```bash
export PATH="$PWD/.runtime/node24/bin:$PATH"
node --version
pnpm --version
```

El servicio invoca el Node local directamente y no depende de herramientas en `/tmp`.

`auth:setup` crea o actualiza `.env`, guarda un hash scrypt y escribe la contraseña aleatoria en **`.dashboard-password`**, ambos con permisos 0600. Lee la contraseña localmente y guárdala en tu gestor. No la copies a Git ni a logs. Ejecutar de nuevo rota la contraseña; reinicia el servicio para invalidar las sesiones existentes. Nunca se imprime el secreto en stdout.

## Acceso y configuración

Abre `http://127.0.0.1:3001`. Para acceder desde otra máquina:

```bash
ssh -N -L 3001:127.0.0.1:3001 USUARIO@SERVIDOR
```

Después abre **exactamente** `http://127.0.0.1:3001` en tu máquina. Si cambias el puerto local, ajusta `DASHBOARD_ORIGIN` y usa ese mismo origen. El servidor valida Host y Origin, usa cookie HttpOnly/SameSite=Strict y no admite CORS abierto. Las sesiones caducan a las ocho horas y se invalidan al reiniciar. No exponer el puerto mediante un proxy público.

Los valores vacíos de Telegram y live están en `.env.example`. `BOT_CONFIG` puede apuntar a un JSON de límites; las claves permitidas y valores iniciales están en `src/engine/model.ts`. Los porcentajes se escriben como fracciones (`0.02` = 2%). El dashboard los muestra como porcentajes.

| Control | Inicial |
|---|---:|
| Capital en `.env.example` | US$50 |
| Capital de referencia de backtest | US$1.000 |
| Pérdida diaria UTC | 2% |
| Drawdown | 10% |
| Exposición por evento/subyacente | 10% |
| Exposición total con reservas | 30% |
| Riesgo de pata sin cobertura | 1% |
| Margen neto mínimo | US$0,02 |
| Costes máximos por par | US$1 |
| Antigüedad máxima del libro | 5 segundos |

El tamaño cae con el drawdown; al 5% es como máximo la mitad. Las ganancias no incrementan el capital operativo por encima del presupuesto configurado. Con US$50 es normal que el mínimo del mercado exceda el riesgo permitido y se omita la operación.

La configuración inicial solo se aplica al crear una base. Después prevalece la configuración persistida, editable en **Riesgo**. Cambiar presupuesto no deposita dinero, no cambia el saldo y no borra PnL. Los flujos de caja tienen registros independientes; `Ledger.cashflow` exige un identificador idempotente. No existe un botón que transfiera fondos.

## Datos y backtesting

### Dejar el bot paper ejecutándose durante días

Desde este servidor, usando la instalación existente:

```bash
cd /home/gabo/portfolio/projects/38-hibraim/botpoly/Polymarket-bot
export PATH="$PWD/.runtime/node24/bin:$PATH"
sudo systemctl restart botpoly.service
pnpm paper:resume
```

Systemd mantiene el proceso al cerrar SSH y lo inicia tras reiniciar el VPS. Una parada de riesgo persiste: no se reanuda automáticamente. Para ver el estado y generar el informe:

```bash
pnpm paper:status
pnpm paper:report --days 5
journalctl -u botpoly.service -f
```

`--days 5` muestra la actividad de los últimos cinco días UTC disponibles; no inventa días anteriores al arranque. El PnL y los costes del informe son acumulados de la cuenta. El informe `reports/paper-actual/report.html` se actualiza automáticamente cada cinco minutos y al detener el proceso; también hay JSON y CSV. Se abre desde Resumen o Backtests del dashboard autenticado. El archivo HTML funciona sin internet. La API de Telegram `/report` también permite obtener informes registrados.

El selector pagina hasta 5.000 mercados generales y consulta eventos de las seis ligas verificadas. Observa hasta 200 mercados: hasta 100 plazas para fútbol, con las libres disponibles para selección general diversificada por evento, liquidez y proximidad al cierre. Renueva cada cinco minutos. Reconstruye mercados con posiciones/reservas desde SQLite y los conserva fuera de ese cupo cuando sea necesario. El dashboard distingue inspeccionados, seleccionados, libros sincronizados y pronósticos disponibles. No cubre toda la plataforma.

**Costes en paper:** las comisiones se leen del mercado. El gas se modela con `PAPER_GAS_UNITS=300000` unidades **supuestas**, precio `fast` de Polygon Gas Station, POL/USD de Coinbase y `PAPER_GAS_MULTIPLIER=1.5`. Los precios caducan y su ausencia bloquea entradas. Las unidades no proceden de `eth_estimateGas`; el modelo queda marcado en los libros, dashboard e informe, y no puede autorizar live. El informe incluye el efecto de triplicar el gas manteniendo las mismas ejecuciones, como sensibilidad de costes.

El SDK público 0.9.0 proporciona snapshots completos por lotes y cambios WebSocket de profundidad. Un nivel de tamaño cero se elimina; mensajes de mejor precio no rejuvenecen libros. Se separan tiempo de origen, recepción y verificación de snapshot completo. Reconectar invalida los libros y exige resincronización. La memoria conserva el último libro completo por token, con cambios agrupados y límites de profundidad; no una cola ilimitada de ticks. Si un lote omite un token, se invalida su condición y se conservan los vecinos válidos.

El simulador vuelve a consultar estado, costes y libros después de la latencia de simulación y el retraso deportivo indicado por el mercado; exige profundidad y frescura para los fills. Los contadores diarios/horarios son exactos y los rechazos detallados se muestrean por minuto. SQLite archiva libros comprimidos cada diez segundos por mercado y los usados para ejecutar: son muestras, no eventos completos. Comprueba disco y detiene entradas y captura si quedan menos de 512 MiB. No borra automáticamente el historial. Haz copias consistentes y revisa espacio al dejarlo periodos largos.

Los fills paper y la liquidez consumida de cada hash de libro se persisten: volver a consultar el mismo libro o reiniciar no permite llenar de nuevo esa profundidad. Un hash nuevo se interpreta como un nuevo estado observado; la reconstrucción exacta entre consultas sigue siendo una limitación. Los informes HTML se abren autenticados en el navegador con scripts deshabilitados y sandbox; JSON y CSV se descargan.

La ejecución preparada el 2026-09-05 usa `.runtime/paper-observation.sqlite` con US$1.000 simulados; `.runtime/paper.sqlite` conserva la prueba anterior de US$50. Esta separación es explícita para el nuevo experimento, no se repite al reiniciar ni borra sus futuras pérdidas. Las claves privadas no se utilizan en paper.

### Backtest sobre archivos

```bash
pnpm data:collect --seconds 60 --interval 1000 --out data/libros.jsonl
# Opcional: --markets ID_GAMMA,ID_GAMMA
pnpm backtest:demo
pnpm backtest --input data/libros.jsonl \
  --from 2026-09-05T10:00:00Z --split 2026-09-05T10:00:30Z \
  --to 2026-09-05T10:01:00Z --capital 1000 \
  --markets CONDITION_ID --out reports/mi-evaluacion \
  --register .runtime/paper.sqlite
```

Usa fechas y condiciones dentro de la cobertura real del manifiesto. La recogida usa IDs Gamma; el backtest usa **condition IDs**, listados en el manifiesto. Cada JSONL tiene `.manifest.json` con fuente, licencia, cobertura y SHA-256. No se sobrescribe un dataset ni un informe existente: utiliza otro nombre para una nueva ejecución.

El backtest reutiliza estrategia, riesgo y contabilidad. La latencia avanza un reloj simulado y consume profundidad del libro futuro solo dentro del ejecutor. Compara la aproximación de límites originales, los mejorados y efectivo; registra 18 ensayos predefinidos (dos periodos por escenario), incluyendo gas ×3, menos liquidez, rechazos, una pata fallida, parciales anómalos y resolución retrasada. No selecciona un ganador con el periodo de evaluación.

Se generan `report.html` autónomo, `result.json`, `trades.csv` y un registro acumulativo `reports/trials.jsonl`. La opción `--register` hace visible el informe en Dashboard y Telegram. Debe guardarse en `reports/NOMBRE` para que las descargas autenticadas funcionen.

Los comandos exactos del dataset público entregado están en `fixtures/public-sample-command.json`. Los informes entregados y sus conclusiones están en `docs/evidence/`.

### PMXT Parquet

El importador dedicado requiere Python con PyArrow; no lo necesita el bot:

```bash
python3 -m venv .runtime/parquet-venv
.runtime/parquet-venv/bin/pip install --only-binary=:all: -r scripts/research/requirements.txt
.runtime/parquet-venv/bin/python scripts/research/test_import_pmxt.py
pnpm data:import --input fixtures/pmxt/excerpt.parquet \
  --mapping fixtures/pmxt/mapping.json --out data/pmxt.jsonl \
  --python .runtime/parquet-venv/bin/python
```

El esquema PMXT v2 se inspeccionó en el archivo real. El importador espera snapshots `book` de ambas patas antes de aplicar `price_change`; un cambio con tamaño cero elimina el nivel. Rechaza cambios fuera de orden por mercado. Los metadatos incluyen ventanas históricas `from`, `to`, `knownAt` para comisiones y gas. No adivina estos valores ni las etiquetas YES/NO. El extracto entregado tiene etiquetas provisionales y `binaryVerified=false`: solo valida el importador y jamás permite entradas.

Licencia del extracto: **CC BY 4.0, PMXT**, fuente exacta en `fixtures/pmxt/mapping.json`. Su checksum, el del mapping y el de la conversión quedan registrados. El archivo íntegro tenía más de 59 millones de filas; solo se leyó un grupo mediante rangos HTTP y se entregó un extracto de un mercado.

## Telegram

Configura únicamente en `.env` privado:

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Los dos campos de `.env.example` están vacíos. En este servidor el usuario ya los configuró en `.env` privado y los envíos reales están comprobados; requieren que el proceso esté funcionando. Solo se aceptan mensajes de un chat **privado** cuyo ID coincide tanto con el chat como con el remitente autorizado.

Comandos: `/status`, `/pnl`, `/positions`, `/risk`, `/pause`, `/resume`, `/cancel_orders`, `/report`. Los comandos que cambian estado caducan a los dos minutos. SQLite conserva offsets, IDs de comandos y cola de salidas. Respeta `retry_after` al enviar y aplica espera exponencial. Los errores no imprimen la URL de Telegram porque contiene el token.

Se envían señales nuevas deduplicadas, reservas, fills confirmados, liquidaciones, fallos y paradas. Cada hora UTC envía estado y PNG: capital, PnL acumulado, drawdown y actividad horaria. A las 00 UTC añade el informe completo; `/report` lo encola con gráfica mientras sigue recibiendo comandos. También envía seguimientos a las 24 y 72 horas desde la primera observación persistida de la cuenta, no desde cada reinicio. Requiere `/usr/bin/rsvg-convert`, ya instalado, para PNG.

Los identificadores horarios persisten; no se repite la hora tras reiniciar ni se reproducen horas antiguas acumuladas. Un fallo de gráfica se informa como fallo. Las rutas se confinan a `reports/` y se conservan hashes de los archivos. Telegram no ofrece idempotencia en `sendMessage`: un timeout después de que el servidor aceptó una alerta puede duplicar **la alerta** al reintentar; los comandos internos no se repiten.

## Recuperación y paradas

- Las órdenes y reservas se escriben antes de enviarlas. Un timeout se concilia; nunca se presupone rechazo ni se reenvía sin identidad externa comprobable.
- Al arrancar y reconectar se concilian órdenes. Una reserva incierta permanece comprometida. El reinicio no borra pérdidas ni paradas.
- **Reanudar** exige conexión y datos frescos, cero errores pendientes, conciliación completa y límites satisfechos. Admite posiciones direccionales de fútbol sanas, con reservas y valoraciones vigentes; sigue rechazando órdenes/canjes inciertos y patas YES/NO pendientes. Una pérdida diaria no se resetea dentro del día UTC. Un drawdown no se resetea por reinicio ni por subir presupuesto.
- **Pausar** bloquea nuevas entradas. **Cancelar órdenes** pausa y concilia, conservando los fills que hayan ocurrido. La recuperación acotada de riesgo sigue funcionando durante una pausa cuando vuelve la liquidez.
- Una fusión incierta queda bloqueada hasta revisar el recibo on-chain. No borrar la intención registrada ni reenviar automáticamente.
- Para copia de seguridad consistente usa la API SQLite `Connection.backup` o `VACUUM INTO` mediante una conexión; verifica `integrity_check`. No copiar solo el `.sqlite` mientras otro proceso escribe. No borrar, sustituir ni renombrar la base activa para resolver una parada.
- El servicio se detiene de forma ordenada con SIGTERM, persiste la parada y cancela/concilia. Tras reiniciarlo, usa Reanudar después de revisar el estado.

## Servicio permanente

`deploy/botpoly.service` está preparado para esta ruta y usuario. Necesita `.runtime/node24/bin/node`, `.env`, `dashboard/dist`, `.runtime` y `reports`. Tiene directorios de escritura acotados, permisos privados y arranque después de la red.

En esta máquina está instalado, habilitado y activo en **paper** desde el 2026-09-06 a las 04:39 UTC. El arranque mediante sudo autenticado resolvió el bloqueo de permisos anterior; `pnpm paper:resume` concilió y reanudó la misma cuenta persistente. Se verificaron evaluaciones crecientes, las once posiciones conservadas y el envío de informe/PNG por Telegram desde la unidad. Consulta [VALIDATION.md](docs/VALIDATION.md) para cifras y comprobaciones fechadas. No iniciar otra instancia mientras el servicio ocupe el puerto.

```bash
./deploy/install.sh
systemctl status botpoly.service
journalctl -u botpoly.service -n 50
sudo systemctl restart botpoly.service
```

El script valida la unidad y usa `sudo -n` para instalarla. Si cambias de máquina, revisa User, Group y rutas de la unidad antes de instalar. No hay despliegue público ni transferencia automática de fondos.

## Live: separado y condicionado

El SDK antiguo CLOB V1 fue retirado. La frontera nueva usa `@polymarket/client` **0.9.0**, firmas actuales, identificadores de activos, rutas de fusión y contratos resueltos por el SDK. El adaptador solo se importa al pasar la autorización live. Se limita a EOA explícita para impedir despliegues implícitos de wallets. No se han enviado operaciones reales durante la implementación.

Para un futuro live se exige `BOT_MODE=live`, otra base (`BOT_DATABASE=.runtime/live.sqlite`), RPC Polygon, clave privada, `LIVE_ACK=ACTIVAR_LIVE_CON_RIESGO_REAL` y `LIVE_EVIDENCE_FILE`. Ese archivo de revisión debe contener `schema:1`, `approvedBy`, `outOfSampleReviewed:true`, `executionAndCostsReviewed:true`, `securityReviewed:true`, `reportPath` y SHA-256 exacto `reportSha256`. Además se comprueba captura de eventos, cobertura, fills de evaluación y resultado neto/intervalo positivos. Los campos ausentes, números no finitos, conteos no enteros, arrays/intervalos inválidos y fills inválidos o duplicados se rechazan incluso con un checksum correcto. Un fixture sintético o el dataset público breve entregado no satisface esos requisitos.

La revisión y el resultado deben incluir `strategies` con identificador, versión y checksum de configuración exactos de YES/NO y fútbol, obtenidos por `strategyBinding`. Fútbol exige además `footballProspectiveReviewed:true` y su propia evidencia `prospective-paper`, al menos 100 fills confirmados, liquidaciones oficiales y PnL/intervalo positivos después de costes. Cambiar configuración invalida el vínculo. Una aprobación YES/NO no habilita fútbol. El informe predictivo retrospectivo no cumple estos requisitos.

Antes de entrar, saldo, posiciones y órdenes remotas deben conciliar con la contabilidad. El heartbeat mantiene la cancelación por pérdida de proceso. Se guarda la orden firmada antes del envío y se confirma por trades/recibos, no por la respuesta de aceptación. Fusión y canje guardan intención/identidad de transacción antes de esperar el recibo; un timeout se concilia sin repetir el envío. El gas proviene de `eth_estimateGas` del calldata de fusión o canje, precio de gas y POL/USD; si la estimación revierte por falta de posiciones u otra causa, se omite la operación. No hay un fallback de gas fijo. Las rutas de wallets gasless no se activan.

**El adaptador live tiene pruebas de frontera simuladas, no validación integral con fondos.** Completar una revisión operativa independiente de firmas, recibos, comisiones, estimación previa de gas y continuidad del feed antes de una activación real. Los scripts antiguos de rescate/aprobación siguen siendo manuales; no forman parte de este circuito.

## Git

Trabaja desde esta carpeta, cuyo remoto es `git@github.com:Hibra999/botpoly.git`. La identidad y SSH locales ya están configuradas. No cambiar la configuración del repositorio padre. El usuario autorizó commit y push de cada modificación verificada.
