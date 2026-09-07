# Migración a operación por Telegram

La cuenta paper y su parada son persistentes. Esta migración no autoriza reanudar ni activar live. La eliminación previa de `propmtnow.txt` queda fuera de los commits.

## Cupo compartido de entradas

`max_oper_per_hour` vale 15 inicialmente. Las migraciones solo incorporan campos ausentes y registran el cambio; no reemplazan los parámetros guardados ni la cuenta. Un cambio parcial conserva los demás límites y aumenta la versión de configuración. El ejecutor paper consulta la frescura vigente también después de esperar la latencia.

`operation_slots` conserva una fila por entrada, común a YES/NO y fútbol. Las dos patas YES/NO comparten identificador. La fila se adquiere en el mismo `BEGIN IMMEDIATE` que el capital. Una entrada pendiente no caduca. Cuando todas sus órdenes de compra terminan, comienza una ventana de 60 minutos; las confirmaciones tardías usan la hora de conciliación. Una venta, recuperación o cancelación no adquiere otra fila. Un rechazo anterior a la reserva no consume cupo. Las filas históricas no se borran al reiniciar ni editar el límite.

La migración reconstruye las entradas desde las órdenes: conserva pendientes y usa tiempos finales/fills disponibles; si no conoce el final, comienza la ventana en la migración. El reloj persistido impide que un retroceso adelante la liberación. Reducir el límite bloquea hasta tener capacidad; si hay demasiados pendientes, la próxima disponibilidad es desconocida.

Prueba específica: `pnpm exec vitest run src/engine/operation-slots.test.ts`. La suite general cubre también fills duplicados, incertidumbre, recuperación, contabilidad y las estrategias.

## Trabajo en curso

Faltan parche de continuidad del SDK, captura y dimensionamiento experimental, revisión de las once entradas, investigación, mediciones comparables y despliegue conservando la parada. Ninguna de estas fases se considera validada por las pruebas del cupo.

## Control confirmado por Telegram

El menú registra comandos en minúsculas según [BotCommand](https://core.telegram.org/bots/api#botcommand); se acepta `/setMaxOps` como alias. `/start` muestra ayuda y estado. `/config clave valor`, `/setmaxops`, `/setbudget` y `/resume` preparan una propuesta SQLite ligada al chat privado y remitente autorizado, comando, versión y dos minutos de caducidad. Confirmar repetidamente conserva el resultado sin repetir efectos; una versión antigua se rechaza también después de conciliar. Pausar impide entradas inmediatamente e invalida una reanudación en curso. Una confirmación nunca autoriza live.

`/audit [n]` admite 1–100, 20 por defecto. Las respuestas largas se dividen en mensajes numerados conservando caracteres completos. API indisponible conserva las salidas para reintentar. Prueba: `pnpm exec vitest run src/app/telegram.test.ts`.

## Arranque e informes

El frontend y servidor web se eliminaron. `pnpm start` y systemd comparten el lanzador compilado con `flock`; la segunda instancia sale 75. `pnpm check:headless` ejecuta paper sin red, con guardias de firmantes y listeners, y comprueba dos lanzadores aislados. No se usa la cuenta operativa en esa prueba.

Los informes corren en un proceso bajo demanda sin secretos en su entorno, con conexión SQLite de solo lectura y transacción coherente. Solo el padre registra resultados/envíos. Se añade resumen Markdown y se conserva PNG/HTML/JSON/CSV, manifiesto y etiquetado explícito de costes live. La prueba del trabajador cubre concurrencia, snapshot entre conexiones, rechazo de escrituras, error de proceso/render y cuenta conservada. No se trata de evidencia de rentabilidad.
