# Migración a operación por Telegram

La cuenta paper y su parada son persistentes. Esta migración no autoriza reanudar ni activar live. La eliminación previa de `propmtnow.txt` queda fuera de los commits.

## Cupo compartido de entradas

`max_oper_per_hour` vale 15 inicialmente. Las migraciones solo incorporan campos ausentes y registran el cambio; no reemplazan los parámetros guardados ni la cuenta. Un cambio parcial conserva los demás límites y aumenta la versión de configuración. El ejecutor paper consulta la frescura vigente también después de esperar la latencia.

`operation_slots` conserva una fila por entrada, común a YES/NO y fútbol. Las dos patas YES/NO comparten identificador. La fila se adquiere en el mismo `BEGIN IMMEDIATE` que el capital. Una entrada pendiente no caduca. Cuando todas sus órdenes de compra terminan, comienza una ventana de 60 minutos; las confirmaciones tardías usan la hora de conciliación. Una venta, recuperación o cancelación no adquiere otra fila. Un rechazo anterior a la reserva no consume cupo. Las filas históricas no se borran al reiniciar ni editar el límite.

La migración reconstruye las entradas desde las órdenes: conserva pendientes y usa tiempos finales/fills disponibles; si no conoce el final, comienza la ventana en la migración. El reloj persistido impide que un retroceso adelante la liberación. Reducir el límite bloquea hasta tener capacidad; si hay demasiados pendientes, la próxima disponibilidad es desconocida.

Prueba específica: `pnpm exec vitest run src/engine/operation-slots.test.ts`. La suite general cubre también fills duplicados, incertidumbre, recuperación, contabilidad y las estrategias.

## Trabajo en curso

Faltan el control Telegram con propuestas persistentes, eliminación web, lanzador compilado con exclusión, informes en trabajador, parche de continuidad del SDK, captura y dimensionamiento experimental, revisión de las once entradas, investigación, mediciones comparables y despliegue conservando la parada. Ninguna de estas fases se considera validada por las pruebas del cupo.
