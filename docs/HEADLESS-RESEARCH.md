# Revisión reproducible: fútbol, ejecución y control

Revisión descriptiva fechada el 7 de septiembre de 2026. No autoriza live ni cambia la salida del fútbol. La fórmula de liquidez/volatilidad es una restricción experimental paper; no tiene rentabilidad demostrada.

## Fuentes y selección

Se buscaron arbitraje Polymarket, modelos Poisson de fútbol y ejecución por Telegram. Para repetir la búsqueda en GitHub: `Polymarket arbitrage bot archived:false`, `football Poisson penaltyblog archived:false` y `Telegram trading bot execution confirmation Freqtrade archived:false`. Comprobar cada resultado con `GET https://api.github.com/repos/OWNER/REPO`; excluir `archived=true` o `disabled=true`. No confundir estrellas, `updated_at` o actividad de issues con cambios de código. Registrar `pushed_at`, rama, `GET /repos/OWNER/REPO/commits/BRANCH`, fecha del commit, licencia SPDX y checksum del JSON recibido. Fijar después todas las lecturas a ese commit y calcular SHA-256 de sus bytes.

Las capturas, fechas exactas, consultas, hashes y commits completos están en [repositories.json](evidence/headless-sources-20260907/repositories.json); los archivos revisados y sus hashes están en [pinned-files.json](evidence/headless-sources-20260907/pinned-files.json). `metadataSha256` identifica la respuesta GitHub original, no el resumen normalizado. La elegibilidad indica que se puede estudiar el proyecto; no acredita seguridad, compatibilidad o rentabilidad. No se incorporó código externo a partir de esta revisión.

| Referencia | Commit fijado | Último push observado | Licencia | Uso y límite |
|---|---|---|---|---|
| [Polybot](https://github.com/cryptuon/polybot/tree/e80974307924afe1d931fe2b8b565e19d9bdf20e) | `e809743` | 2026-07-16 | MIT | Contrastar controles de riesgo comunes y separación paper/live. Su infraestructura multivenue, Docker y monitorización no se añaden a Botpoly. Las afirmaciones del README no constituyen evidencia de fills o beneficios. |
| [Hummingbot: seguimiento de órdenes](https://github.com/hummingbot/hummingbot/blob/2bfaccc48dd49e71a5b6d9b3011808e127dd00cd/hummingbot/connector/client_order_tracker.py) | `2bfaccc` | 2026-09-05 | Apache-2.0 | Distingue órdenes activas, cacheadas y perdidas, y mantiene órdenes que pueden recibir fills tardíos. Botpoly conserva incertidumbre en SQLite; no adopta un TTL para liberar capital ni cupos. |
| [Penaltyblog: Poisson](https://github.com/martineastwood/penaltyblog/blob/5ebd602d6b431aafe753add5264bbfc29a154c56/penaltyblog/models/poisson.py) | `5ebd602` | 2026-08-21 | MIT | Referencia para estimar fuerzas local/visitante y producir una matriz de marcadores. Comparar Poisson, recencia y Dixon–Coles en orden temporal; una etiqueta de docstring no demuestra que dos modelos sean equivalentes. |
| [Freqtrade: Telegram](https://github.com/freqtrade/freqtrade/blob/202c1c429cabfb949e26fb85979049c3f84ae165/freqtrade/rpc/telegram.py) | `202c1c4` | 2026-09-07 | GPL-3.0 | Patrones observados: verificar chat/remitente también en callbacks y responder mediante navegación. No se copia código GPL. La propuesta SQLite de Botpoly conserva su propia versión, caducidad e idempotencia. |
| [Market maker oficial antiguo](https://github.com/Polymarket/poly-market-maker/tree/55b83499ffc81bbd6b7c15c40ff9179b5e3d323c) | `55b8349` (2024-03-11) | 2024-07-05 | MIT | Referencia histórica exclusivamente. GitHub no lo marca archivado en esta captura, pero eso no lo convierte en una integración actual. Excluido de candidatos de integración. |

Para el transporte se revisó [el SDK oficial fijado en 8898914](https://github.com/Polymarket/ts-sdk/blob/8898914b31f9c06301a365f436aa558d3d725241/packages/client/src/websockets/clob/market.ts): el iterador permanece durante reconexiones. El parche versionado expone estado y generación, manteniendo heartbeat/reconexión del SDK. Los nombres del menú cumplen [BotCommand](https://core.telegram.org/bots/api#botcommand), aunque el parser acepta `/setMaxOps`.

## Once entradas: protocolo antes de interpretar

La fuente es la copia consistente `.runtime/backups/pre-headless-20260907T020101Z.sqlite`, cuya integridad completa devuelve `ok`, SHA-256 `778e2f5ece1c147079bd2af7283afb5f9a142b8307e83c7bb1754cc35a2d3847`. Se abre de solo lectura; no se migra ni escribe. La reconstrucción enlaza cada compra con fills, señal, forecast, checksum de datos, precio, profundidad, comisiones, gas, ventas, valoración abierta y resolución oficial.

```bash
pnpm build
node dist/src/research/football-review-cli.js \
  --database .runtime/backups/pre-headless-20260907T020101Z.sqlite \
  --out reports/REVISION-NUEVA
```

El destino debe ser nuevo. Se generan Markdown, HTML, JSON, CSV y manifiesto con hashes de archivos, fuente, código y periodo. La revisión publicada se enlaza desde [HEADLESS.md](HEADLESS.md).

La política actual se describe por su contabilidad real **paper**: ventas al +10% neto ejecutable o resolución, más valoraciones abiertas explícitas. Mantener hasta resolución solo recibe resultado final si el snapshot contiene su prueba oficial. Stop del 10% calcula el primer cruce observado usando toda la cantidad original, profundidad completa, comisiones y gas del frame; los libros posteriores a la resolución se excluyen. El JSON conserva también el primer cruce observado del take-profit. Estos escenarios no crean fills, saldo o beneficios.

Los huecos entre libros impiden identificar el primer cruce real o asegurar que una orden se habría ejecutado. No interpolar ni rellenar precios; mostrar muestras inválidas, cobertura inicial/final y mayor hueco. Cuando falta resolución, dejar el resultado final desconocido. No sumar once resultados heterogéneos para declarar una variante ganadora: unos incluyen marks y otros carecen de cierre. El resultado negativo y las limitaciones forman parte del informe.

Antes de comparar alternativas nuevas, fijar otra muestra prospectiva y el código/configuración exactos: mismas entradas congeladas, horarios/identidades verificados, libros de ambas patas, latencia, profundidad, tarifas, gas y resoluciones. Registrar todos los casos; separar ajuste y evaluación cronológicamente, incluir calibración/Brier/log-loss frente a frecuencia base y cuotas disponibles en ese momento, intervalos por bloques de partido y costes ejecutables. Las cuotas de cierre son un comparador retrospectivo, no una variable disponible anticipadamente. Mantener salida actual hasta una revisión independiente de esa nueva evidencia.

## Pumas: conservar dos valores

[Captura Gamma y checksum](evidence/headless-sources-20260907/pumas-verification.json), mercado `3849972`: título **“Will Pumas de la UNAM win on 2026-09-06?”**, inicio verificado **2026-09-11 03:00:00 UTC**, Pumas de la UNAM–Club León, partido guardado `mex:90112713`. El inicio del snapshot coincide con `gameStartTime` de la captura actual; la fecha textual es diferente. La captura actual no demuestra cuándo se cambió el título u horario. Otras diferencias de día pueden deberse a zona horaria; no se diagnostican a partir de texto solo.

Antes de una entrada, volver a obtener mercado y evento y comparar condición, partido, liga, equipos, resultado y hora. Si cambian, rechazar y revisar. La discrepancia del título se presenta junto al inicio UTC y no activa una venta de la posición existente.
