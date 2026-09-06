# Comparación de repositorios y próximas mejoras

Revisión estática del **2026-09-06**. Hay ideas útiles para evaluar, pero no evidencia de que copiar otra estrategia mejore el rendimiento de Botpoly. No se ejecutaron los repositorios externos ni se instalaron sus dependencias. Se conservaron sus revisiones y SHA-256 de los archivos leídos en el [manifiesto de comparación](evidence/repo-comparison-20260906.json).

## Punto de partida observado

El informe paper de **2026-09-06T04:52:51.789Z** registra capital inicial de US$1.000, capital neto de **US$990,87866**, PnL de **−US$9,12134 (−0,912134%)**, comisiones de US$2,67237 y gas contabilizado de US$0. Son once compras simuladas de fútbol, todas abiertas, sin ventas ni liquidaciones; no hay beneficios realizados. El valor de salida contempla profundidad y comisión de venta. El gas de futuras salidas sigue siendo modelado, no gasto confirmado.

El informe local `reports/paper-performance-request-20260906T0452/` conserva JSON, HTML, CSV y gráfica con manifiesto propio. La comparación conserva su checksum, configuración y periodo. El PnL es acumulado de la cuenta, no una rentabilidad realizada del periodo ni dinero de una wallet.

La [evaluación cronológica existente](FOOTBALL.md#evaluación-cronológica-reproducible) también es negativa frente al mercado: en 2.001 pronósticos de evaluación, Brier 0,593861 frente a 0,579763 de las cuotas de cierre sin margen; menor es mejor. No contiene ejecuciones históricas de Polymarket. Estas limitaciones pesan más que las afirmaciones de rentabilidad de cualquier README externo.

## Repositorios inspeccionados

| Referencia fijada | Hallazgo en el código | Aplicación a Botpoly |
|---|---|---|
| [warproxxx/poly-maker, 4f321035](https://github.com/warproxxx/poly-maker/tree/4f32103591c9582ccd012bdf10f77d86e5879444) | `estimators.py` mide el cambio de valor después de cada fill y lo resume con decaimiento temporal. `quoting.py` ajusta cotizaciones y tamaño por inventario, volatilidad y movimiento adverso. | Medir primero si las entradas sufren un movimiento adverso posterior. Su ejecución maker requiere estudiar cola y cancelaciones; los fills FOK actuales no demuestran que una orden pasiva se habría ejecutado. |
| [pontiggia/poly-bot, d335edd9](https://github.com/pontiggia/poly-bot/tree/d335edd9c3ce8f1d14968aa2245028d6f9780683) | `edge_calculator.rs` combina margen, comisión, spread y riesgo parcial, pero aproxima la comisión como tasa por coste combinado y limita profundidad al mejor nivel. | Botpoly ya cotiza por niveles, aplica la tasa verificada y reserva costes/riesgo. Esa aproximación no aporta una mejora demostrada. Mantener el cálculo existente. |
| [jpmouracodex/football-mle, 51494de7](https://github.com/jpmouracodex/football-mle/tree/51494de7912e3b7135ed9491f07c937b9466ea44) | `dixon_coles.py` ajusta dependencia de marcadores bajos mediante rho; su README describe ponderación temporal. | Candidato offline para contrastar el Poisson independiente actual. Mejor ajuste dentro de la muestra no demuestra mejor pronóstico ni mayor PnL. |

Las decisiones de la última columna son inferencias de esta revisión, no resultados de un backtest comparativo nuevo. Las afirmaciones de rendimiento de los proyectos no se verificaron independientemente.

## Orden propuesto de evaluación

1. **Medir calidad de entrada y disponibilidad.** Reutilizar fills y libros archivados para comparar precio/coste de compra con salida ejecutable a horizontes predefinidos, por ejemplo 1, 5 y 30 minutos. Registrar faltantes, desfase respecto al horizonte y costes; no convertir un precio intermedio en una venta. El informe acumulaba 151.229 rechazos por datos obsoletos/futuros y 45.443 por valoración obsoleta: son evaluaciones repetidas e incluyen estados anteriores, no oportunidades únicas perdidas. Medir su distribución actual y el tiempo de cada etapa antes de cambiar el bucle o ampliar la cobertura. Conservar el umbral de frescura.
2. **Comparar Dixon–Coles y ponderación temporal fuera del arranque.** Fijar candidatos y parámetros con desarrollo, conservar todos los ensayos y exigir probabilidades válidas. Contrastar calibración, Brier y log-loss por liga contra Poisson y cuotas sin margen. El periodo 2025-07 a 2026-07 ya fue observado: volver a usarlo para elegir una variante no crea una evaluación intacta. Reservar un periodo nuevo o evidencia prospectiva, después comprobar ejecución y costes.
3. **Considerar maker solo con datos de cola y cancelación.** El archivo actual contiene muestras, no todos los eventos. Hace falta medir llenado, cancelación, riesgo de una sola pata e inventario antes de simular beneficios maker. No sustituir FOK por órdenes pasivas a partir de sus mejores precios visibles.

La mejora entregada ahora es de seguimiento: **Resumen → Capital y rendimiento** alterna una línea de USD o porcentaje del capital inicial y respeta intervalos UTC. Conserva pérdidas y descuenta flujos externos del PnL. Las propuestas anteriores quedan como candidatas medibles; no se ha cambiado el modelo, aumentado Kelly, reducido el margen mínimo ni activado live.
