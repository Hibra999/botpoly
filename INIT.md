# Botpoly: instalación y operación por Telegram

Bot headless con arbitraje YES/NO y fútbol Poisson, contabilidad SQLite y simulación. No abre un servidor HTTP. Toda estrategia pasa por Engine → reserva transaccional → ejecutor → confirmación → Ledger. Paper y backtest no necesitan firmantes. No hay evidencia suficiente para activar live.

## Entorno

Node **24.20.0**, pnpm **10.32.1**, un workspace y un `pnpm-lock.yaml`. `.npmrc` desactiva todos los scripts de instalación; `onlyBuiltDependencies` está vacío. No ejecutar `approve-builds` ni reintroducir lockfiles npm.

```bash
export PATH="$PWD/.runtime/node24/bin:$PATH"
node --version
pnpm --version
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm typecheck
pnpm build
pnpm start
```

`pnpm start` y systemd invocan `deploy/start.sh`: adquiere `.runtime/engine.lock` con `flock`, comprueba Node y ejecuta `dist/src/app/run.js`. Una segunda instancia sale con código 75 antes de cargar el motor o Telegram. La compilación es previa al arranque. No hay servidor web, autenticación HTTP, cookies ni contraseña del dashboard.

## Configuración privada

Usa `.env.example` como referencia y configura `.env` con permisos 0600. Telegram es obligatorio al arrancar: token con formato válido y un ID seguro de chat privado. El chat y remitente deben coincidir. La disponibilidad de su API no condiciona el motor: errores y rate limits conservan las salidas pendientes. Nunca imprimir el token, URLs de Telegram, claves, sesiones ni credenciales CLOB.

`BOT_MODE=paper`, `CAPITAL_USD`, `BOT_DATABASE`, `BOT_CONFIG` y `POLL_INTERVAL_MS` controlan el arranque. `BOT_CONFIG` puede apuntar a un JSON validado. La configuración inicial solo se aplica al crear una cuenta; después prevalecen los parámetros SQLite. Las migraciones incorporan únicamente campos ausentes y registran el cambio.

El capital mínimo es US$50. Esta instalación conserva la cuenta simulada de US$1.000 iniciada el 2026-09-05 en `.runtime/paper-observation.sqlite`; `.runtime/paper.sqlite` conserva el experimento anterior de US$50. No cambiar de base para eludir pérdidas o una parada.

| Parámetro | Inicial |
|---|---:|
| Pérdida diaria UTC | 2% |
| Drawdown | 10% |
| Exposición por evento/subyacente | 10% |
| Exposición total con reservas | 30% |
| Riesgo de pata sin cobertura | 1% |
| Margen neto mínimo | US$0,02 |
| Costes máximos por par | US$1 |
| Frescura máxima | 5 segundos |
| `max_oper_per_hour` compartido | 15 |

El tamaño disminuye con drawdown. Las ganancias no elevan el presupuesto. Cambiar presupuesto no crea saldo, depósitos ni beneficios; el denominador histórico de pérdidas permanece. `Ledger.cashflow` es independiente y exige un identificador idempotente; Telegram no transfiere fondos.

## Comandos

| Comando | Acción |
|---|---|
| `/start` | Ayuda, estado y navegación; no reanuda |
| `/status`, `/pnl` | Estado, contabilidad y costes |
| `/positions`, `/risk` | Valoraciones, exposición, reservas y cupos |
| `/pause` | Bloquea entradas inmediatamente |
| `/cancel_orders` | Bloquea, cancela y concilia preservando incertidumbre |
| `/resume` | Propuesta de reanudación con comprobaciones actuales |
| `/config` | Parámetros y versión vigentes |
| `/config clave valor` | Cambio parcial propuesto |
| `/setmaxops num`, `/setMaxOps num` | Entero positivo seguro; alias aceptado |
| `/setbudget amount` | Presupuesto del modo activo, mínimo US$50 |
| `/report` | Resumen Markdown, PNG, HTML/JSON/CSV y manifiesto |
| `/audit [n]` | Eventos, 20 inicialmente; máximo 100 |

Los nombres del menú son minúsculos según [Telegram BotCommand](https://core.telegram.org/bots/api#botcommand). Cambios y `/resume` tienen vista previa con Confirmar/Cancelar. SQLite liga cada propuesta al chat, remitente, comando, versión y caducidad de dos minutos. Repetir una confirmación no repite efectos; una propuesta antigua se rechaza también después de conciliar. Ningún comando activa live.

Una entrada YES/NO consume un cupo aunque tenga dos patas. Fútbol comparte ese límite. El cupo se adquiere junto al capital en `BEGIN IMMEDIATE`. Los pendientes no caducan; al terminar definitivamente todas las compras, permanecen 60 minutos más. Los rechazos anteriores a reservar no consumen; los intentos reservados/enviados sí. Salidas, recuperaciones y cancelaciones no adquieren otro cupo. Reducir el límite por debajo del uso bloquea hasta tener capacidad. Reiniciar o editar no borra filas. El reloj persistido trata conservadoramente los retrocesos.

## Informes y alertas

Un proceso bajo demanda, máximo uno simultáneo, abre SQLite de solo lectura y captura una transacción coherente. El motor registra los resultados y envíos. `/usr/bin/rsvg-convert` genera PNG sin navegador. Los informes conservan español, fondo oscuro, procedencia, periodos, configuración, hashes, estados vacíos y limitaciones. Live etiqueta fills y costes reales confirmados; las valoraciones y escenarios siguen siendo estimaciones.

Se conservan alertas y offsets en SQLite. Las respuestas extensas se dividen en mensajes numerados. Se mantiene estado horario, el informe diario y seguimientos a las 24/72 horas de la primera observación. No se recrean horas anteriores al arrancar. Un timeout de envío aceptado por Telegram puede duplicar una alerta: su API no ofrece idempotencia; los comandos internos sí son idempotentes. Fallos de renderizado se muestran como fallos y conservan los otros archivos.

## Datos y estrategias

Se inspeccionan hasta 5.000 mercados generales y eventos de seis ligas, observando hasta 200 condiciones con hasta 100 plazas para fútbol. Posiciones y reservas retenidas añaden cobertura cuando sea necesaria. No es cobertura total de Polymarket.

Fútbol mantiene una entrada por partido, seleccionando entre alternativas por valor esperado neto ejecutable. Poisson usa historial verificado, ventaja mínima de 5 puntos, 1/4 Kelly, 1% por partido y 10% agregado. Conserva salida al +10% neto ejecutable o resolución oficial. No hay apuestas nuevas durante el juego ni probabilidades in-play. Véanse [FOOTBALL.md](docs/FOOTBALL.md) y [HEADLESS.md](docs/HEADLESS.md) para revisión y fases de la migración.

Paper consulta libros y costes después de la latencia y del retraso deportivo. Los fills y la profundidad consumida se persisten por hash: reiniciar no reutiliza el mismo libro. Un hash nuevo representa un estado observado, no prueba prioridad de cola. Se archivan muestras de libros cada diez segundos y las usadas para ejecutar; no son un archivo completo de eventos. Se bloquean entradas/captura si el disco libre baja de 512 MiB; no se borra historial automáticamente.

Gas paper: `PAPER_GAS_UNITS=300000` unidades **supuestas**, precio fast de Polygon Gas Station, POL/USD de Coinbase y `PAPER_GAS_MULTIPLIER=1.5`. Datos caducados bloquean entradas. No procede de `eth_estimateGas` y no autoriza live. El escenario de gas ×3 conserva las mismas ejecuciones: es sensibilidad de costes, no una nueva simulación de decisiones.

```bash
pnpm data:collect --seconds 60 --interval 1000 --out data/libros.jsonl
pnpm backtest --input data/libros.jsonl \
  --from FECHA_UTC --split FECHA_UTC --to FECHA_UTC \
  --capital 1000 --markets CONDITION_ID --out reports/mi-evaluacion
```

Usa periodos dentro de la cobertura del manifiesto. La captura usa IDs Gamma, el backtest condition IDs. Cada dataset conserva fuente, licencia, cobertura y SHA-256. No sobrescribir resultados ni presentar `fixtures/demo.jsonl` sintético como rentabilidad real. Se conservan todos los ensayos, incluidos resultados negativos o insuficientes; no se selecciona una variante con el periodo de evaluación. Los datasets antiguos siguen siendo legibles; no crean observaciones históricas que no contienen.

El importador PMXT requiere Python/PyArrow y snapshots completos de ambas patas antes de deltas. No adivina comisiones, gas ni etiquetas. El extracto CC BY 4.0 entregado tiene etiquetas provisionales, `binaryVerified=false`, y solo valida el importador.

```bash
python3 -m venv .runtime/parquet-venv
.runtime/parquet-venv/bin/pip install --only-binary=:all: -r scripts/research/requirements.txt
.runtime/parquet-venv/bin/python scripts/research/test_import_pmxt.py
pnpm data:import --input fixtures/pmxt/excerpt.parquet \
  --mapping fixtures/pmxt/mapping.json --out data/pmxt.jsonl \
  --python .runtime/parquet-venv/bin/python
```

## Paradas y despliegue

Una parada no se reanuda por reinicio. `/resume` requiere datos frescos, conexión, errores resueltos, conciliación completa y límites satisfechos. Admite posiciones fútbol sanas con sus reservas/valoraciones; rechaza patas YES/NO, canjes y órdenes inciertos. Una confirmación no anula pérdidas todavía incumplidas. Pausar durante una conciliación impide que esta termine reanudando.

Nunca borrar, reinicializar, sustituir ni renombrar `.runtime/*.sqlite` para resolver una parada. Las órdenes se persisten antes del envío. Una fusión o canje incierto conserva intención y reserva: no se reenvía automáticamente. El cierre SIGTERM bloquea entradas, cancela/concilia y conserva la parada existente.

Hacer copia consistente con SQLite `backup` o `VACUUM INTO`, verificar `integrity_check` y guardar hashes. No copiar solo el archivo `.sqlite` mientras hay escritores. Las migraciones son aditivas.

```bash
pnpm test
pnpm typecheck
pnpm build
sudo ./deploy/install.sh
systemctl status botpoly.service
journalctl -u botpoly.service -n 50
```

La unidad exige Node local, `.env`, `dist`, `.runtime` y `reports`. El instalador necesita privilegios root para systemd; ejecuta `sudo ./deploy/install.sh` en una terminal autorizada. Mantiene permisos privados, `NoNewPrivileges`, protección de sistema/home/kernel y directorios de escritura acotados. El instalador valida la unidad y usa `sudo -n`. La copia y migración se ejecutan como el usuario `gabo`, conservando la propiedad privada de los archivos. Detiene el servicio, adquiere el mismo `flock`, crea una copia SQLite consistente, comprueba su integridad completa y hash, y compara cuenta/órdenes/fills/posiciones/reservas/liquidaciones antes y después de las migraciones aditivas. Conserva los parámetros previos y la parada. El manifiesto privado queda en `.runtime/backups/headless-*.json`; si falla una comprobación, mantiene el servicio detenido para revisión, sin sustituir la base. La prueba aislada es `node deploy/migrate.mjs --self-test`. Revisar las rutas/usuario en otra máquina. La reanudación corresponde al comando autorizado después de revisar el estado. No ejecutar el arranque antiguo con tsx.

## Live separado

Solo `BOT_MODE=live`, una base separada, RPC Polygon, clave privada, `LIVE_ACK=ACTIVAR_LIVE_CON_RIESGO_REAL` y `LIVE_EVIDENCE_FILE` revisado permiten importar el adaptador. La evidencia exige schema, revisor, comprobaciones de seguridad/ejecución/costes, reporte y SHA-256 exacto, cobertura fuera de muestra y resultados válidos. Fútbol requiere evidencia prospectiva propia con al menos 100 fills, liquidaciones oficiales y PnL/intervalo positivos después de costes. Una aprobación YES/NO no habilita fútbol. Véase `authorizeLive` y [SECURITY-AND-RESEARCH.md](docs/SECURITY-AND-RESEARCH.md).

`strategyBinding` vincula ambas estrategias, versiones y configuración exacta. Cambiar configuración bloquea nuevas entradas live hasta una revisión compatible. El adaptador requiere conciliación remota, heartbeat, trades/recibos y gas estimado del calldata; no usa fallback fijo. Solo EOA explícita. Sus pruebas son simuladas: no equivalen a validación con fondos. Scripts de rescate, depósitos y aprobaciones son manuales y ajenos al arranque. Las mutaciones antiguas de `trading-service.ts` siguen desactivadas.

## Git y validación

Repositorio real: esta carpeta `Polymarket-bot/`, remoto `Hibra999/botpoly`, rama `main`; no operar sobre el Git padre. Publicar cada modificación coherente verificada con commit y push. Excluir la eliminación previa de `propmtnow.txt` y todos los secretos.

Ejecutar `pnpm test`, `pnpm typecheck`, `pnpm build` y pruebas pertinentes; si cambia el importador, ejecutar sus pruebas Python. `test:integration` heredado consulta APIs públicas; no ocultar incompatibilidades externas con un `catch` silencioso. Los informes y [VALIDATION.md](docs/VALIDATION.md) indican cobertura y limitaciones fechadas; la evidencia histórica no verifica por sí sola un cambio posterior.
