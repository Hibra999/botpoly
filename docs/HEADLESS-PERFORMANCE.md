# Rendimiento del arranque headless

Protocolo de comparación del 7 de septiembre de 2026. Las entradas son sintéticas y solo miden consumo y latencia de evaluación; no son rentabilidad real ni evidencia live.

## Reproducción

```bash
export PATH="$PWD/.runtime/node24/bin:$PATH"
pnpm build
# Copia de referencia creada una sola vez en un directorio nuevo:
mkdir -p .runtime/replay-reference
git archive 80d61477f4b500e622b76acd4e39dd4f7e9cd043 | tar -x -C .runtime/replay-reference
ln -s ../../node_modules .runtime/replay-reference/node_modules
printf '%s\n' 80d61477f4b500e622b76acd4e39dd4f7e9cd043 > .runtime/headless-baseline-commit.txt
python3 scripts/research/measure-headless.py \
  --baseline .runtime/replay-reference --out reports/PERFORMANCE-NUEVO \
  --seconds 120 --repeats 2
```

El destino de medición debe ser nuevo. El archivo `headless-baseline-commit.txt` debe identificar el commit realmente extraído; no asignar el hash de esta referencia a otro código. El baseline importa su grafo original TypeScript con tsx y abre su dashboard inactivo en un puerto efímero local. El proceso headless carga JavaScript compilado y el trabajador real de informes. Ambos usan Node 24.20.0 y las mismas dependencias instaladas; el parche SDK no participa porque no hay transporte de exchange. Se deshabilita fetch y no se crean firmantes ni se envían órdenes o mensajes.

Cada repetición reproduce 200 mercados, dos patas, diez niveles por lado, un lote cada 500 ms, durante 120 segundos: 48.000 frames. El estado inicial es una cuenta paper vacía y detenida. Precios, comisiones, gas y secuencia tienen el mismo SHA-256 en ambas variantes. Se archivan 2.400 libros y se generan dos informes completos con PNG; el nuevo proceso añade las observaciones y estadísticas de la política de tamaño. La reserva/ejecución no se fuerzan: se verifica que no hay órdenes.

Se alterna el orden baseline/headless y headless/baseline. Cada 100 ms se suma RSS del árbol de procesos, incluidos trabajador y rsvg-convert. CPU incluye hijos actuales y ya recogidos por el padre. La latencia es desde la llegada programada del lote hasta terminar su evaluación; refleja retrasos acumulados, no latencia de una orden real. Los tiempos de informe incluyen el arranque del trabajador. La mediana excluye los primeros 30 segundos; los picos incluyen todo.

## Criterio y límites

Exigir menos RSS mediano y menor pico con informes que la referencia. Para cada corrida headless, después de 30 segundos: pendiente lineal de RSS ≤5 MiB/min y mediana del segmento final ≤ mediana del anterior +8 MiB. Publicar CPU y latencia aunque empeoren. No usar GC forzado ni borrar muestras. Dos minutos no descartan toda fuga de larga duración; mantener observación operativa.

El host tiene dos CPU lógicas y otros servicios, incluido el bot anterior. No es hardware aislado: hay contención variable. RSS suma páginas compartidas más de una vez y el muestreo puede perder picos inferiores a 100 ms. La cuenta vacía permite comparar el mismo trabajo sin tocar SQLite operativo; no representa el coste de todos los historiales reales.

Los [ensayos iniciales](evidence/headless-performance-initial-20260907/LIMITATIONS.md) incumplieron el criterio; el primer baseline además coincidió parcialmente con la reconstrucción de fútbol. La [medición intermedia](evidence/headless-performance-intermediate-20260907/LIMITATIONS.md) redujo el pico pero aún acumulaba sentencias de captura. Ambas se conservan completas. La corrección reutiliza las formas SQL fijas de Store y de observaciones, manteniendo parámetros y transacciones.

## Observación extendida

Las dos repeticiones finales de 120 segundos siguen sin aprobar el criterio desde los 30 segundos; se conservan en [la prueba corta](evidence/headless-performance-short-20260907/LIMITATIONS.md). Se añade una pareja baseline/headless de **360 segundos** con el mismo código, umbral y protocolo (`--seconds 360 --repeats 1`): 144.000 frames y 7.200 libros por versión, informes a los 120 y 240 segundos. Se evalúa el crecimiento del proceso durante el arranque y el mantenimiento posterior, sin GC forzado ni cambiar el umbral después de medir.
