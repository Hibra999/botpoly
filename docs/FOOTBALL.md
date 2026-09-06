# Fútbol automático en paper

Botpoly combina arbitraje YES/NO y `football-value` en el mismo `Engine`, las mismas reservas transaccionales y el mismo `Ledger`. El modelo de fútbol es matemático, sin LLM. La evaluación disponible **no demuestra rentabilidad**: pierde frente a las cuotas de cierre en calidad predictiva. Live sigue sin autorización; el estado operativo fechado está en [VALIDATION.md](VALIDATION.md).

## Mercados y descubrimiento

Se admiten Premier League (`epl`), LaLiga (`lal`), Bundesliga (`bun`), Serie A (`sea`), Ligue 1 (`fl1`) y Liga MX (`mex`). Se excluyen Mundial y clasificatorias. La identificación exige coincidencia de liga/serie deportiva, equipos, local/visitante, hora de inicio, proposición y reglas. Un nombre parecido o un alias ambiguo no basta.

El alcance actual es **V1, moneyline binario Yes/No, primeros 90 minutos más descuento**: victoria local, empate o victoria visitante. No incluye prórroga, penaltis, clasificación, totales, córners ni marcador exacto. NegRisk solo admite la compra/venta direccional individual verificada; sigue excluido del arbitraje YES/NO estándar y no hay conversiones multiresultado.

Cada cinco minutos se paginan hasta 5.000 mercados generales y los eventos de las seis ligas. Se seleccionan hasta 200 mercados, con hasta 100 plazas para fútbol; las libres se aprovechan para selección general diversificada por evento, liquidez y proximidad al cierre. Los mercados con posiciones o reservas se reconstruyen desde SQLite y se conservan fuera del cupo si hace falta. Estos límites no son una cobertura completa de Polymarket. El dashboard muestra por separado inspeccionados, seleccionados, fútbol, pronósticos y libros sincronizados.

## Modelo, fuentes y entrada

`poisson-clubs-v1` calcula tasas de ataque/defensa regularizadas hacia la media de la liga, incorpora localía y combina dos distribuciones Poisson para normalizar las probabilidades local/empate/visitante. Para comprar NO usa el complemento de la proposición correspondiente. No incorpora alineaciones, lesiones ni información en directo del partido.

| Parámetro fijo | Valor |
|---|---:|
| Historial | 730 días |
| Muestra mínima por equipo | 10 partidos |
| Regularización hacia la media | 5 partidos equivalentes |
| Ventaja mínima estimada después de costes | 5 puntos porcentuales |
| Fracción Kelly | 1/4 |
| Exposición máxima por partido | 1% del capital operativo |
| Exposición agregada máxima de fútbol | 10% del capital operativo |
| Ventana de entrada | Entre 1 hora y 7 días antes del inicio |
| Objetivo de salida | 10% neto ejecutable sobre el coste |

Los límites globales de saldo, reservas, exposición, pérdida diaria, drawdown, coste y frescura también se aplican. El tamaño disminuye con el drawdown. Se comprueba profundidad y mínimo del mercado; no se relajan límites para producir operaciones. La ventaja es `probabilidad − coste total / cantidad`; Kelly se calcula con ese precio después de costes y después se aplican los topes compartidos.

Se permite una apuesta por partido, persistida antes de ejecutar. La marca permanece incluso si el intento es totalmente rechazado: no hay reentrada automática. Antes de reservar, el motor compara YES/NO de las alternativas verificadas disponibles en el mismo lote por valor esperado neto ejecutable, con profundidad, costes, Kelly y límites actuales. Desempata por condición y registra la comparación; no supone que las seis alternativas estén disponibles. La reserva vuelve a comprobar los límites transaccionalmente. Tampoco se aumenta una posición por nuevos ticks, otro submercado o reinicios. No se abren apuestas durante el juego ni se presenta el pronóstico previo como actualizado durante el partido.

Los resultados proceden de los [CSV gratuitos de Football-Data](https://football-data.co.uk/data.php), una fuente por lotes, no un feed actual de cuotas. Europa usa `https://football-data.co.uk/mmz4281/TEMPORADA/CODIGO.csv` con códigos `E0`, `SP1`, `D1`, `I1`, `F1`; México usa [MEX.csv](https://football-data.co.uk/new/MEX.csv). Se conservan temporadas anteriores. Los datos siguen sujetos a las condiciones del proveedor; no se atribuye una licencia de redistribución que no se haya verificado.

El cargador valida CSV, fechas completas, goles, filas, duplicados, conflictos y equipos ambiguos. Conserva cada CSV original en `.runtime/football/SHA256.csv`, la procedencia y el checksum del historial reconstruido. Consulta las fuentes cada seis horas; una caché íntegra puede conservarse ante fallos, pero si su última verificación supera siete días no hay pronóstico. No se sustituyen fallos por resultados supuestos.

Solo entran resultados anteriores al corte: el menor entre el inicio del partido y el comienzo del día UTC actual. La caché de pronósticos depende del partido, checksum de datos y día UTC. Football-Data no aporta el historial completo de revisiones ni la hora histórica exacta de publicación; la evaluación retrospectiva no demuestra disponibilidad intradía de cada dato.

## Ejecución, salida y contabilidad

El flujo automático es `Engine → reserva transaccional → ejecutor → confirmación → Ledger`. Señales, reservas, fills y liquidaciones son eventos distintos. Las señales no generan PnL. Las posiciones direccionales pasan por `finishFootball`; no por la fusión de pares YES/NO.

El SDK público 0.9.0 combina snapshots completos REST por lotes y cambios WebSocket de profundidad. Un tamaño cero elimina el nivel. Identidad y tiempos se validan; recepción, tiempo de origen y verificación REST se conservan separados. Los avisos de mejor precio o última operación no rejuvenecen la profundidad. Tras reconectar se invalida y resincroniza. Un token ausente en un lote invalida su condición y conserva los vecinos válidos. La memoria mantiene el último estado por token y agrupa cambios; SQLite guarda **muestras cada diez segundos** y libros usados para ejecutar, no todos los eventos del mercado.

Paper reconsulta estado, costes y profundidad tras la latencia simulada y el retraso deportivo `secondsDelay`. La liquidez consumida se conserva por token/lado/hash, incluso en una secuencia A → B → A y tras reiniciar. Un hash nuevo sigue siendo una nueva observación: la prioridad de cola y la reconstrucción exacta entre muestras no están demostradas.

La salida anticipada exige profundidad para cerrar toda la posición y un importe de venta, descontando comisiones y costes aplicables, de al menos el 110% de su coste. La orden es FOK y solo los fills confirmados cambian efectivo/PnL. Una salida parcial conserva el resto; una salida incierta se concilia sin reenviarla ni liberar su reserva.

Si no existe esa salida, se mantiene hasta resolución oficial. No se liquida por Football-Data ni por terminar el partido: se exige Gamma cerrado/resuelto y vector CTF coherente en Polygon (chainId 137), leído en un bloque fijo confirmado. Se contemplan ganador, perdedor y pago fraccionario. La intención de canje se persiste antes de ejecutar, se concilia ante incertidumbre y se contabiliza de forma idempotente con su base de coste. El alcance V1 no se amplía a otros contratos sin revisión.

En esta instalación las comisiones proceden del mercado; el gas paper usa **300.000 unidades supuestas**, precio `fast` de Polygon Gas Station, POL/USD de Coinbase y multiplicador **1,5**. Se exige frescura. No es `eth_estimateGas` ni gasto real; los informes conservan esta limitación y sensibilidad de gas ×3. Las operaciones y pérdidas paper son simuladas, aunque los libros observados sean públicos reales.

## Evaluación cronológica reproducible

Se conserva un único modelo/configuración predefinido. Desarrollo: **2023-07-01 ≤ fecha < 2025-07-01**. Evaluación: **2025-07-01 ≤ fecha < 2026-07-01**. No se eligió un ganador ni se ajustaron parámetros con el periodo de evaluación. Cada predicción usa únicamente resultados anteriores al día del partido.

| Periodo / referencia | Predicciones | Brier multiclase | Log-loss |
|---|---:|---:|---:|
| Desarrollo: Poisson | 3.569 | 0,591243 | 0,990403 |
| Desarrollo: frecuencias históricas | 3.569 | 0,651328 | 1,076148 |
| Desarrollo: cuotas de cierre sin margen | 3.569 | 0,573019 | 0,963965 |
| Evaluación: Poisson | 2.001 | 0,593861 | 0,996456 |
| Evaluación: frecuencias históricas | 2.001 | 0,646547 | 1,069715 |
| Evaluación: cuotas de cierre sin margen | 2.001 | 0,579763 | 0,974479 |

Menor es mejor. Brier suma los tres errores cuadrados (rango 0–2); log-loss usa logaritmo natural. Las cuotas de referencia solo usan `AvgCH/AvgCD/AvgCA` completas y se normalizan para retirar el margen. En esta muestra todos los casos predichos tienen esas tres cuotas. Se conservan calibración por resultado/decil y cobertura: 5.570 predicciones de 6.272 partidos elegibles, con 702 excluidos por muestra insuficiente.

El modelo mejora la frecuencia histórica y **empeora las cuotas de cierre**. Esto mide calidad predictiva; no contiene operaciones, PnL ni fills ejecutables de Polymarket. La observación prospectiva paper mantiene aparte latencia, costes, reservas, operaciones y resolución.

Artefactos versionados:

- [Resumen completo de métricas, calibración y limitaciones](evidence/football-20260906.json), sin las filas individuales; añade el comando de reproducción y referencia al manifiesto.
- [Manifiesto de procedencia y hashes](evidence/football-20260906-manifest.json): 21 CSV de origen y seis historiales reconstruidos. Sus hashes de `result.json`, `predictions.csv` y `report.html` corresponden a los originales locales en `reports/football-evaluation-20260906-replay/`, **no** al JSON resumido de documentación.

Las fuentes se verificaron el 2026-09-06 alrededor de las 03:19 UTC; el manifiesto de la reproducción inicial tiene `capturedAt=1788664901097` (03:21:41.097 UTC). La reproducción del cierre conserva idénticos CSV de predicciones, métricas y configuración. SHA-256 de `predictions.csv`:

```text
ce6d0e6a10c85eefcda97749aa126439f11b9173596ae365aafd6e5465500865
```

Desde la raíz, con Node/pnpm de [INIT.md](../INIT.md), y con los 21 CSV originales en `.runtime/football/`:

```bash
pnpm football:evaluate \
  --manifest docs/evidence/football-20260906-manifest.json \
  --out reports/football-offline-replay
```

El destino debe ser nuevo. Con `--manifest` no se descargan ni sustituyen datos: se verifican los hashes de los CSV y del historial reconstruido. Clonar solo Git no proporciona esos CSV. Hay que conservarlos junto con los manifiestos; volver a descargar una URL mutable no garantiza obtener los mismos bytes. `capturedAt` y los hashes de un nuevo JSON/HTML cambian al reproducir; el CSV determinista conserva el hash anterior. Los informes anteriores no se sobrescriben.

Para una evaluación nueva con descarga de fuentes: `pnpm football:evaluate --out reports/NOMBRE-NUEVO`. La opción `--register .runtime/paper-observation.sqlite` registra un enlace de calidad predictiva para el dashboard; no introduce operaciones, PnL ni evidencia live.

La atribución de ideas de Poisson, regularización y Kelly se conserva en el informe hacia [pypro_polymarket_agent, revisión e7ed2f35](https://github.com/memonkey01/pypro_polymarket_agent/tree/e7ed2f35bf4bf0a7fef5d3c497cd9aff62d3b0a5). Botpoly implementa su propio modelo/motor, sin copiar aquel proyecto ni sus dependencias. Esa referencia no constituye evidencia de ventaja de Botpoly.

## Seguimiento y barrera live

El dashboard en español muestra cobertura, fuentes, última evaluación, uptime, motivos de rechazo y posiciones con partido, estrategia, política de salida y antigüedad de valoración. Telegram conserva señales, reservas, fills, liquidaciones, estado/PNG horario UTC, informe diario a las 00 UTC, `/report` encolado y seguimientos de 24/72 horas. El PNG oscuro incluye capital, PnL, drawdown, actividad y costes, identificado como PAPER. Los IDs y la cola son persistentes; no se simulan horas ni updates de usuario para acreditar recepción real.

`experimentStartedAt` deriva del primer registro válido de la cuenta y no del despliegue de los reportes: aquí es **2026-09-05T06:42:23.706Z**. Los seguimientos vencen el 2026-09-06 y el 2026-09-08, respectivamente, a esa hora. Su ejecución real requiere que el proceso esté funcionando; consultar confirmaciones fechadas en [VALIDATION.md](VALIDATION.md).

Live exige activación explícita, revisión humana, checksum del informe y vínculos exactos `strategyBinding` de ambas estrategias/configuraciones. Se rechazan cobertura/fills ausentes, tipos incorrectos, números no finitos, conteos no enteros, intervalos incompletos/invertidos y fills inválidos o duplicados. Fútbol requiere evidencia propia `prospective-paper`, 100 fills confirmados como mínimo, liquidaciones oficiales y resultado/intervalo netos positivos. Ni esta evaluación retrospectiva ni un fixture sintético lo cumplen.

El adaptador live solo tiene pruebas de frontera simuladas. Continúa pendiente su revisión operativa independiente de firmas, recibos, comisiones, heartbeat y gas; no se han realizado pruebas con fondos. Paper y backtest no importan el adaptador de firma. No existe activación live en dashboard o Telegram.
