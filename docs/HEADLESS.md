# Migración a operación por Telegram

La cuenta paper y su parada son persistentes. Esta migración no autoriza reanudar ni activar live. La eliminación previa de `propmtnow.txt` queda fuera de los commits.

## Cupo compartido de entradas

`max_oper_per_hour` vale 15 inicialmente. Las migraciones solo incorporan campos ausentes y registran el cambio; no reemplazan los parámetros guardados ni la cuenta. Un cambio parcial conserva los demás límites y aumenta la versión de configuración. El ejecutor paper consulta la frescura vigente también después de esperar la latencia.

`operation_slots` conserva una fila por entrada, común a YES/NO y fútbol. Las dos patas YES/NO comparten identificador. La fila se adquiere en el mismo `BEGIN IMMEDIATE` que el capital. Una entrada pendiente no caduca. Cuando todas sus órdenes de compra terminan, comienza una ventana de 60 minutos; las confirmaciones tardías usan la hora de conciliación. Una venta, recuperación o cancelación no adquiere otra fila. Un rechazo anterior a la reserva no consume cupo. Las filas históricas no se borran al reiniciar ni editar el límite.

La migración reconstruye las entradas desde las órdenes: conserva pendientes y usa tiempos finales/fills disponibles; si no conoce el final, comienza la ventana en la migración. El reloj persistido impide que un retroceso adelante la liberación. Reducir el límite bloquea hasta tener capacidad; si hay demasiados pendientes, la próxima disponibilidad es desconocida.

Prueba específica: `pnpm exec vitest run src/engine/operation-slots.test.ts`. La suite general cubre también fills duplicados, incertidumbre, recuperación, contabilidad y las estrategias.

## Trabajo en curso

Faltan revisión de las once entradas, investigación, mediciones comparables y despliegue conservando la parada. Ninguna de estas fases se considera validada por las pruebas del cupo.

## Control confirmado por Telegram

El menú registra comandos en minúsculas según [BotCommand](https://core.telegram.org/bots/api#botcommand); se acepta `/setMaxOps` como alias. `/start` muestra ayuda y estado. `/config clave valor`, `/setmaxops`, `/setbudget` y `/resume` preparan una propuesta SQLite ligada al chat privado y remitente autorizado, comando, versión y dos minutos de caducidad. Confirmar repetidamente conserva el resultado sin repetir efectos; una versión antigua se rechaza también después de conciliar. Pausar impide entradas inmediatamente e invalida una reanudación en curso. Una confirmación nunca autoriza live.

`/audit [n]` admite 1–100, 20 por defecto. Las respuestas largas se dividen en mensajes numerados conservando caracteres completos. API indisponible conserva las salidas para reintentar. Prueba: `pnpm exec vitest run src/app/telegram.test.ts`.

## Arranque e informes

El frontend y servidor web se eliminaron. `pnpm start` y systemd comparten el lanzador compilado con `flock`; la segunda instancia sale 75. `pnpm check:headless` ejecuta paper sin red, con guardias de firmantes y listeners, y comprueba dos lanzadores aislados. No se usa la cuenta operativa en esa prueba.

Los informes corren en un proceso bajo demanda sin secretos en su entorno, con conexión SQLite de solo lectura y transacción coherente. Solo el padre registra resultados/envíos. Se añade resumen Markdown y se conserva PNG/HTML/JSON/CSV, manifiesto y etiquetado explícito de costes live. La prueba del trabajador cubre concurrencia, snapshot entre conexiones, rechazo de escrituras, error de proceso/render y cuenta conservada. No se trata de evidencia de rentabilidad.

## Continuidad del libro

`patches/@polymarket__client@0.9.0.patch` añade estado/generación y notificación síncrona al handle CLOB individual. Conserva heartbeat y reconexión del SDK. Los eventos llevan su generación para descartar colas anteriores; una respuesta REST que cruza una reconexión tampoco se acepta. BookStream invalida inmediatamente y exige libro completo antes de deltas/entradas. Los cambios despiertan el motor agrupados durante 100 ms, manteniendo el temporizador de frescura/mantenimiento.

La fuente oficial revisada es [market.ts en 8898914](https://github.com/Polymarket/ts-sdk/blob/8898914b31f9c06301a365f436aa558d3d725241/packages/client/src/websockets/clob/market.ts). `scripts/research/patch-sdk-connection.py` reproduce las sustituciones exactas sobre el paquete 0.9.0 extraído por `pnpm patch`. El diff generado es grande porque el paquete publica dos bundles minificados; las sustituciones semánticas son acotadas y verifican coincidencias únicas. Los sourcemaps originales siguen correspondiendo a upstream. Prueba: `src/research/sdk-connection.test.ts`, usando el SDK real sobre transporte simulado, sin órdenes.

## Dimensionamiento experimental y captura

Política `observed-liquidity-volatility-v1`, aplicada en paper. Presupuesto final = `min(presupuesto vigente, 0.01 × p10_liquidez_24h) × min(1, maxSlippageBps / max(volatilidad_bps, 1))`. El percentil usa interpolación lineal; volatilidad es desviación poblacional de 60 variaciones relativas por minuto, tomando la mayor de YES y NO. El presupuesto final nunca supera el previo. Se vuelven a comprobar mínimos, profundidad, costes, ventaja y límites/Kelly existentes.

Se exigen 12 capturas Gamma de la última hora y 60 variaciones válidas consecutivas. El historial de liquidez abarca solo las 24 horas observadas. Cada precio medio ocupa un intervalo UTC de un minuto y conserva la fecha real de captura; se rechazan libros cruzados/vacíos/caducados y huecos. La falta de cobertura omite nuevas entradas sin impedir salidas o resolución. Las fechas de captura no prueban conocimiento anterior. Esta fórmula es una política conservadora experimental, sin rentabilidad demostrada.

`market_observations` conserva entradas únicas por mercado/tipo/intervalo. Los frames guardan estadísticas compactas y hashes de los inputs; el informe añade `observations.jsonl` con los datos fuente de las últimas 24 horas y SHA-256, sin cargarlos todos en memoria. El coletor guarda además una SQLite de observaciones con checksum en el manifiesto. Los datasets antiguos siguen legibles, con evaluación de tamaño heredado explícita; no son evidencia de esta política. Los nuevos frames sin cobertura suficiente se rechazan también al reproducirlos.

La preparación usa como máximo ocho condiciones simultáneas; la reserva/ejecución siguen serializadas. Los precios de gas comparten una consulta en curso. Cada frame conserva su generación de conexión y se descarta si la preparación cruza una reconexión. La identidad y horario del fútbol se vuelven a verificar con el evento antes de ejecutar; una discrepancia del título no crea una venta. `/positions` muestra el inicio UTC y conserva el título.

Pruebas: `sizing.test.ts`, suites de estrategias, observación, cupos y reconexión. Los fixtures de cobertura son sintéticos y solo se importan desde pruebas. La competencia por un cupo se comprueba también con dos procesos SQLite reales.
