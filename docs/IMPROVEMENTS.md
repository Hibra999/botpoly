# Ocho mejoras solicitadas: implementación y verificación

Objetivo: los ocho puntos del adjunto del 2026-09-06. Esta lista conserva todo el alcance; un resultado negativo o insuficiente no se convierte en rentabilidad. El modo sigue siendo paper y la cuenta SQLite conserva posiciones, costes, pérdidas y reservas.

| Punto | Estado y evidencia | Verificación pendiente |
|---|---|---|
| 1. Calidad a 1, 5 y 30 minutos | Implementada en `account-analysis.ts`, informe y dashboard. En la cuenta observada: 9/11 válidas a 1 minuto, 11/11 a 5 y 11 ausentes a 30. | Verificada en API y dashboard desplegados; actualización cada cinco minutos. |
| 2. Frescura y evaluaciones repetidas | Implementadas métricas y evaluación de cambios; REST verifica frescura sin repetir snapshots idénticos. | 115 pruebas; quince ciclos observados, 1.337 evaluaciones omitidas entre 3.000 condiciones. |
| 3. Dixon–Coles y recencia | Pendiente; Poisson actual conservado como referencia. | Comparación cronológica reproducible, procedencia, todos los ensayos y límites de selección. |
| 4. Calibración por liga | Pendiente; existe calibración agregada. | Métricas y calibración por liga/modelo/periodo, con cobertura y muestras insuficientes visibles. |
| 5. Alternativas del mismo partido | Implementada comparación previa de alternativas del lote por valor esperado neto ejecutable. | Pruebas de mejor alternativa, falta de profundidad/costes/frescura, reinicio, parada y reserva única. |
| 6. Concentración | Implementada por liga, equipo y liga/fecha UTC, incluyendo reservas. Los equipos se solapan; la fecha es una aproximación de jornada, no ronda oficial. | Verificadas en escritorio, móvil y teclado contra el servicio desplegado. |
| 7. Dashboard | Implementadas tablas por estrategia/liga, realizado/abierto, comisiones/gas y línea de efectivo sin operar. | Integración verificada; cero infracciones axe, referencia de efectivo y depósitos/retiros comprobados. |
| 8. Maker | Capturados 6.306 eventos públicos y 960 snapshots en 12 minutos; pendiente evaluador. | Recogida de eventos y evaluación explícita de suficiencia; investigar llenados parciales, cola y latencia de cancelación sin órdenes reales. |

## Primera entrega: análisis contable

El análisis es derivado y no modifica saldo, fills, posiciones ni reservas. Cada desglose se reconstruye con compras, ventas, pagos de liquidación, gas y posiciones actuales. Las pérdidas con pago cero se conservan. Los costes sin atribución suficiente y diferencias de redondeo aparecen en `sin-atribuir`, por lo que ambos desgloses cuadran con el PnL de la cuenta. El efectivo de referencia conserva los mismos depósitos/retiros y no supone intereses.

La calidad de entrada usa el primer snapshot válido entre el horizonte y 30 segundos después. Exige identidad, profundidad, cantidad mínima, frescura y costes. Registra hash SHA-256 del blob original, ID del frame, origen temporal, desfase y costes. Diferencia observado, pendiente, ausente, inválido y sin liquidez. La liquidación hipotética de cada fill completo incluye ambas comisiones y gas de recuperación modelado; no son ventas ni beneficios del Ledger y no se suman horizontes entre sí.

Las filas de concentración muestran coste más reservas y porcentaje del capital inicial. El proveedor verificado no aporta una ronda oficial: la agrupación de jornada usa explícitamente liga y fecha UTC. Se conserva esa limitación en la interfaz y en el informe.

Informe real local: `reports/paper-analysis-20260906/`. Se generó en 282 ms, con métricas contables idénticas antes/después. Capital US$990,87866; PnL −US$9,12134; once fills simulados abiertos. El manifiesto conserva los hashes de JSON/HTML/CSV y el JSON incluye configuración, periodos, costes y fuentes de cada observación. No se ha inventado cobertura a los treinta minutos.

Validación del código: 110 pruebas en 13 archivos, typecheck y build. Se extendió la comprobación de depósitos/retiros del histórico y se verificaron ventas parciales, pago cero, gas sin atribución, suma de grupos y ausencia de mutaciones al medir calidad. Playwright revisó escritorio 1440 px, móvil 390 px, tablas desplazables por teclado, detalles, estados vacíos y accesibilidad (cero infracciones). La prueba visual usa el artefacto de análisis real sobre un snapshot aislado, porque la recarga del servicio se hará junto con los cambios del bucle; no acredita todavía su integración desplegada.

## Segunda entrega: procesamiento y selección

El servicio recargó `botpoly-v4-batch-analysis` a las 06:01:32 UTC y se reanudó mediante el control normal. La copia consistente anterior y la cuenta activa conservan las mismas once posiciones, cantidades, costes e identidades, capital inicial y flujos. No se sustituyó SQLite. Evidencia: [batch-processing-20260906.json](evidence/batch-processing-20260906.json).

Se verificaron 115 pruebas en 13 archivos, typecheck, build y Playwright contra la API real desplegada: escritorio 1440 px, móvil 390 px, teclado, tablas desplazables, estados vacíos y cero infracciones axe. La prueba de flujos comprueba que US$400 netos depositados y otro presupuesto operativo no alteran un rendimiento de −2% con PnL −US$20 sobre US$1.000 iniciales.

Veinte consultas en 57 segundos contienen quince ciclos únicos: 1.657 condiciones evaluadas, 1.337 omitidas por no cambiar y seis sin frame válido, conservadas para reintento. Mediana del ciclo: 1.220 ms; no hay una medición anterior comparable para afirmar aceleración relativa. Todos los estados consultados estuvieron conectados, sin parada ni errores. La antigüedad sigue validándose por condición; no todos los libros están necesariamente frescos en todo momento.
