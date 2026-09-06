# Ocho mejoras solicitadas: implementación y verificación

Objetivo: los ocho puntos del adjunto del 2026-09-06. Esta lista conserva todo el alcance; un resultado negativo o insuficiente no se convierte en rentabilidad. El modo sigue siendo paper y la cuenta SQLite conserva posiciones, costes, pérdidas y reservas.

| Punto | Estado y evidencia | Verificación y límites |
|---|---|---|
| 1. Calidad a 1, 5 y 30 minutos | Implementada en `account-analysis.ts`, informe y dashboard. En la cuenta observada: 9/11 válidas a 1 minuto, 11/11 a 5 y 11 ausentes a 30. | Verificada en API y dashboard desplegados; actualización cada cinco minutos. |
| 2. Frescura y evaluaciones repetidas | Implementadas métricas y evaluación de cambios; REST verifica frescura sin repetir snapshots idénticos. | 115 pruebas; quince ciclos observados, 1.337 evaluaciones omitidas entre 3.000 condiciones. |
| 3. Dixon–Coles y recencia | Evaluadas cuatro variantes: Poisson, recencia de 365 días y corrección Dixon–Coles condicional en ambas. | 2.001 partidos comunes de evaluación; mejora pequeña y peor que cuotas de cierre. No se promueve modelo. |
| 4. Calibración por liga | Calibración por liga, modelo, periodo, resultado y decil, con intervalos descriptivos y muestras insuficientes. | No autoriza nuevos tamaños; todas las variantes y bins se conservan en el informe reproducible. |
| 5. Alternativas del mismo partido | Implementada comparación previa de alternativas del lote por valor esperado neto ejecutable. | Pruebas de mejor alternativa, falta de profundidad/costes/frescura, reinicio, parada y reserva única. |
| 6. Concentración | Implementada por liga, equipo y liga/fecha UTC, incluyendo reservas. Los equipos se solapan; la fecha es una aproximación de jornada, no ronda oficial. | Verificadas en escritorio, móvil y teclado contra el servicio desplegado. |
| 7. Dashboard | Implementadas tablas por estrategia/liga, realizado/abierto, comisiones/gas y línea de efectivo sin operar. | Integración verificada; cero infracciones axe, referencia de efectivo y depósitos/retiros comprobados. |
| 8. Maker | Investigación completada con captura, evaluador reproducible y escenarios de cola/latencia/costes; evidencia insuficiente. | 13 avisos de trades, cero fills confirmados ni prioridad propia comprobada; no se incorpora maker al arranque. |

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

## Tercera entrega: comparación predictiva y calibración

`pnpm football:compare --manifest docs/evidence/football-20260906-manifest.json --out reports/NOMBRE-NUEVO` reproduce los cuatro ensayos fijados en [el protocolo](evidence/football-comparison-plan-20260906.json), sin red ni claves. Los originales se restauran por checksum. El informe entregado está en `reports/football-comparison-20260906/` y su [evidencia versionada](evidence/football-comparison-20260906.json) conserva periodos, fuentes, parámetros, cobertura, costes no observados y hashes de los artefactos completos.

| Evaluación 2025/26, 2.001 partidos comunes | Brier | Log-loss |
|---|---:|---:|
| Poisson actual | 0,593861 | 0,996456 |
| Recencia 365 días | 0,593258 | 0,995641 |
| Corrección Dixon–Coles | 0,593628 | 0,995942 |
| Recencia + corrección | 0,593190 | 0,995417 |
| Cuotas de cierre sin margen | 0,579763 | 0,974479 |

La corrección Dixon–Coles ajusta rho por máxima verosimilitud condicional sobre las tasas Poisson regularizadas existentes; no reproduce el ajuste conjunto de ataque/defensa del repositorio de referencia. Usa solo resultados anteriores al día, ventana de 730 días y mínimo de veinte marcadores bajos. Se conservan 22.248 predicciones de los cuatro modelos y 3.968 ajustes, incluidos 85 en el borde permitido. Desarrollo pierde dieciséis casos comunes por muestra insuficiente de la corrección; se muestran también los denominadores propios.

La calibración usa treinta celdas por liga/modelo/periodo (tres resultados y diez deciles), tamaño de muestra, probabilidad media, frecuencia observada y Wilson 95% descriptivo. La discrepancia absoluta media ponderada del Poisson base en evaluación va del 2,89% en Serie A al 5,44% en LaLiga; las celdas pequeñas se señalan. Los intervalos no ajustan dependencia ni comparaciones múltiples y no certifican calibración. No se habilita un nuevo dimensionamiento.

Los resultados son retrospectivos y el periodo 2025/26 del modelo base ya se había observado antes; no se presenta como un holdout intacto para seleccionar modelo. La mejora es pequeña, varía por liga y todos quedan por detrás de las cuotas de cierre. No contiene fills ni PnL de Polymarket y no activa live. El predictor de producción reproduce exactamente las 5.570 predicciones originales (mismo SHA-256), comprobado con guardia contra importación de firmantes. Pasaron 116 pruebas en 14 archivos, typecheck y build.

El HTML autónomo se revisó en escritorio y móvil, con apertura de calibración por teclado, foco visible y estados de muestra insuficiente. Las tablas tienen desplazamiento propio sin desbordar la página.

## Cuarta entrega: investigación maker

El colector público reproducible y su evaluador offline reutilizan el SDK, validación de libros y cálculo de profundidad/comisiones existentes. No crean firmantes, envían órdenes ni escriben el Ledger. La selección del colector lee SQLite en modo de solo lectura; los datos se guardan en un directorio nuevo, con manifiesto, periodo, parámetros y SHA-256. Comandos:

```bash
pnpm maker:collect --seconds 720 --limit 20 --out data/NOMBRE-NUEVO
pnpm maker:analyze --input data/NOMBRE-NUEVO --out reports/NOMBRE-NUEVO
```

Captura entregada: `data/maker-events-20260906`, 05:50:54–06:02:57 UTC, cuarenta tokens de veinte mercados, 6.306 eventos, 960 snapshots y trece avisos de trades validados. El manifiesto marca finalización normal; la reconstrucción identifica 49 invalidaciones de libro y no acredita secuencia completa del exchange. Informe: `reports/maker-analysis-20260906/`; [evidencia, costes y hashes](evidence/maker-analysis-20260906.json).

Se evaluaron 480 ventanas hipotéticas de US$10 a mejor bid, 250 ms de entrada, 60 segundos de permanencia y 250 ms adicionales para cancelar. Hubo 422 ventanas completas según los controles del escenario, dieciocho inválidas y cuarenta cortadas por el fin de captura. Se comprueba post-only al llegar y se cuenta el volumen posterior a la petición de cancelación hasta su acuse supuesto. La profundidad eliminada no se convierte en trades ni reduce automáticamente la cola previa.

| Escenario supuesto | Ventanas con fill hipotético | Parciales | Salidas valorables |
|---|---:|---:|---:|
| Sin cola por delante | 2 | 1 | 1 |
| Profundidad visible por delante | 0 | 0 | 0 |

La única salida valorable del escenario sin cola dio US$0 antes del gas supuesto: −US$0,01 o −US$0,03 con esas sensibilidades. El otro parcial fue de 0,06 participaciones y carece de salida valorable; se conserva como inventario hipotético, sin inventar valor. Estas cifras parciales no son el PnL de una estrategia. La comisión maker cero procede de la documentación consultada; no se acreditan rebates. Los costes de salida usan los metadatos iniciales; el gas no está verificado históricamente.

**Conclusión: evidencia insuficiente para introducir órdenes maker.** Los dos escenarios de cola son supuestos, no límites demostrados. Faltan identidad/prioridad propia, acuses reales de entrada/cancelación y fills privados; trece avisos públicos y doce minutos tampoco permiten medir rentabilidad. El trabajo pedido queda investigado y reproducible, con su resultado negativo; una futura estrategia maker requiere nueva evidencia antes de integrarse en Engine.

Pasaron 117 pruebas en quince archivos, typecheck y build. La prueba pertinente cubre parciales, costes, duplicados, eliminaciones de profundidad, gap, reloj y cancelación. Un ensayo público adicional de diez segundos con el colector versionado produjo un manifiesto íntegro, dos tokens y su replay, bajo guardia que prohíbe importar firmantes. El informe HTML se revisó en escritorio, móvil y teclado.

## Estado del alcance

Los puntos 1, 2, 5, 6 y 7 están implementados y comprobados en el servicio paper; 3 y 4 están evaluados y publicados sin promover un modelo nuevo; 8 se investigó y documentó como insuficiente. No hay una activación live pendiente de este trabajo ni se afirma una mejora de rentabilidad. Quedan como trabajo futuro la observación prospectiva más larga, datos de jornada oficial, validación independiente del dimensionamiento y evidencia verificable para maker.

## Mejoras futuras, por prioridad

1. **Completar observación prospectiva.** Más entradas y liquidaciones oficiales, con cobertura continua de los horizontes de calidad y costes. Es la evidencia pendiente para juzgar resultados netos.
2. **Validar ajustes de calibración y tamaño.** Evaluar una transformación por liga con periodos nuevos, sin ajustar ni elegir parámetros con el mismo conjunto usado para informar resultados.
3. **Probar Dixon–Coles con ajuste conjunto.** Registrar otro ensayo de ataque/defensa y rho, compararlo con las cuatro variantes conservadas y medir incertidumbre antes de promoverlo.
4. **Evaluar límites de concentración adicionales.** Usar la exposición ya medida para estudiar topes por equipo y liga, incluyendo reservas y oportunidades descartadas.
5. **Obtener jornada oficial verificable.** Sustituir la aproximación por liga/fecha UTC cuando una fuente aporte identidad de ronda y procedencia suficientes.
6. **Ampliar evidencia maker.** Más duración y mercados, continuidad del feed y validación de cola, parciales y cancelaciones; después valorar si una estrategia pasiva merece integrarse en Engine.
