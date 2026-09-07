# Seguridad, investigación y límites de la implementación

Revisión: **2026-09-05**. No se enviaron órdenes reales, transacciones ni aprobaciones financieras. La revisión inicial precedió a la entrega de credenciales de Telegram; posteriormente el usuario las configuró y autorizó el arranque con alertas e informes. El servicio operativo usa `paper`.

## Hallazgos corregidos

1. El antiguo servidor aceptaba comandos WebSocket sin sesión, publicaba CORS abierto y escuchaba sin limitar interfaz. Fue sustituido por HTTP/WebSocket en 127.0.0.1, sesión scrypt/HttpOnly/SameSite, validación estricta Host/Origin y comandos de esquema cerrado. Hay límites de payload, conexiones y frecuencia, caducidad de sesión y protección de rutas, symlinks y descargas.
2. Había configuración y bucles duplicados, estrategias que ejecutaban fuera del control global y PnL simulado a partir de señales. Los dos entrypoints apuntan ahora al motor central; las mutaciones de los servicios antiguos lanzan un error. El PnL nace de fills/recibos confirmados, inventario a coste medio, fusión y costes. La simulación no crea un cliente de trading.
3. Los límites y paradas vivían en memoria. SQLite conserva capital, reservas, órdenes, fills, posiciones, costes, límites, paradas, controles y salidas de Telegram. Las reservas son transacciones `BEGIN IMMEDIATE`, con claves únicas. Se comprueban duplicados y confirmaciones contradictorias. Las operaciones remotas se concilian antes de reintentar; un resultado incierto conserva capital comprometido.
4. Se retiró `@polymarket/clob-client` y se usa `@polymarket/client` 0.9.0. Las funciones antiguas de análisis tienen una frontera de compatibilidad pública; el adaptador live usa el SDK nuevo, sin direcciones copiadas del cliente V1. No se ha certificado la compatibilidad live completa con fondos.
5. Se importaron ambos lockfiles y después se actualizaron dependencias. Instalación sin scripts, sin correcciones automáticas de auditoría. Las versiones vulnerables de `ws`, `bn.js`, `rollup`, `postcss` y `nanoid` se reemplazaron mediante overrides acotados al major correspondiente.

## Auditoría de dependencias

`pnpm audit` después de las correcciones: **0 críticos, 0 altos, 0 moderados y 1 bajo**. El aviso restante es `elliptic <=6.6.1`, "Elliptic Uses a Cryptographic Primitive with a Risky Implementation", traído por ethers 5, que sigue siendo dependencia del SDK heredado y del adaptador EOA. La auditoría no ofrece versión parcheada. No se ocultó ni se desactivó la advertencia. El proceso paper no crea wallets ni usa esta ruta de firma.

La ausencia de avisos altos no equivale a una auditoría de seguridad completa. Los scripts de dependencia permanecen desactivados. No se detectó exfiltración evidente en los entrypoints y circuitos inspeccionados; esto no es una certificación de todo el código histórico ni de todos sus proveedores.

## Scripts manuales con efectos financieros

`scripts/rescue/rescue-contract.ts` y `scripts/rescue/rescue-erc1155.ts` construyen/despliegan contratos y envían transacciones que pueden transferir fondos o ERC-1155. También existen scripts manuales de depósitos, aprobaciones, redención, swaps y trading archivado. No se eliminaron datos del usuario ni se ejecutaron estos scripts. Ninguno es importado por `src/app/main.ts`, el servicio systemd, Telegram o el backtest.

No ejecutar material histórico siguiendo el README original sin revisar contratos, destinatarios y cantidades. Los archivos de referencia conservan APIs anteriores. Las únicas rutas de operación actuales se documentan en `INIT.md`.

## Investigación aplicada

- [SDK oficial](https://github.com/Polymarket/ts-sdk): se inspeccionaron README, exportaciones, tipos y la versión npm 0.9.0. El cliente requiere Node 24. Se usan clientes públicos para datos y una importación dinámica para live. Las nuevas estructuras usan `assetId`, metadatos por condición y workflows de fusión.
- [Comisiones oficiales](https://docs.polymarket.com/trading/fees): el cálculo depende del precio, cantidad y tasa del mercado; no se infiere una tasa nula de la ausencia de datos. El modelo implementa el exponente documentado de uno y rechaza metadatos de otro exponente salvo tasa cero. Se redondean comisiones a cinco decimales y contabilidad a seis.
- [Heartbeat oficial](https://docs.polymarket.com/api-reference/trade/send-heartbeat): la frontera live firma el endpoint de heartbeat y detiene entradas si se pierde. Los FOK limitan cada pata, pero no dan atomicidad al par.
- [Estudio de arbitraje](https://arxiv.org/abs/2508.03474): motiva buscar precios complementarios inconsistentes; los beneficios observados por otros operadores no prueban la rentabilidad de este bot. La implementación considera profundidad, costes y recuperación de una pata.
- [Archivo PMXT](https://archive.pmxt.dev/): licencia CC BY 4.0. Se inspeccionó el Parquet v2 real por rangos HTTP. El importador reconstruye snapshots y cambios, registra checksum y requiere metadatos históricos explícitos. El extracto entregado es de un solo mercado y no verifica sus etiquetas ni costes.
- [Sobreajuste del backtest](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf): se fijan variantes antes de evaluar, se conservan todos los ensayos y se separan periodos cronológicos. Se calcula incertidumbre mediante remuestreo de bloques con semilla fija. No se interpreta un intervalo de una muestra breve como evidencia suficiente.
- [Telegram Bot API](https://core.telegram.org/bots/api): los offsets y comandos se persisten; la autorización exige chat privado y remitente coincidentes. Los reintentos respetan la respuesta de límites de envío. La API no garantiza idempotencia de entrega de alertas, así que puede haber duplicados tras un timeout de envío.
- [Scripts de pnpm](https://pnpm.io/cli/approve-builds): no se habilitó ningún script de dependencia. La lista permitida está vacía y la instalación verificada funciona con los binarios opcionales existentes.

## Límites operativos que siguen vigentes

Actualización de seguimiento paper (2026-09-05): se corrigió el selector que tomaba la primera página sin filtrar y se añadió un modelo de gas exclusivo de simulación. Usa precios públicos actuales de [Polygon Gas Station](https://docs.polygon.technology/tools/gas/polygon-gas-station) y POL/USD, con unidades y margen declarados como supuestos. `gasVerified` permanece falso; la excepción del motor solo admite ese modelo validado en paper/backtest y lo rechaza en live. Se guardan libros comprimidos, contadores diarios e informes periódicos. Los informes históricos siguientes conservan sus resultados originales; no se han recalculado para aparentar beneficios.

- **Rentabilidad no demostrada.** El fixture sintético produce fills inventados por el simulador y solo sirve para validar el programa. Las capturas oficiales y PMXT entregadas terminan sin operaciones por metadatos/costes insuficientes. Se conserva `paper`.
- **Gas previo a la compra.** `eth_estimateGas` de una fusión puede revertir si la cuenta aún no posee las posiciones. En ese caso el adaptador omite la entrada; no usa gas fijo. Hacen falta simulaciones de estado o un entorno de estimación revisado para resolver esa condición de forma operativa. Las rutas gasless no están habilitadas.
- **Validación live pendiente.** Solo se probaron las fronteras con mocks. Las firmas actuales, fees efectivamente cobrados, recibos, cancelación por heartbeat y estimaciones necesitan validación integral independiente antes de aportar la aprobación de live. No se declara el bot listo para operar dinero real.
- **Contabilidad y gas.** El capital neto descuenta gas valorado en USD; el saldo CLOB remoto se concilia contra efectivo contable más gas acumulado, porque ese gas se paga con POL. La conversión POL/USD se consulta al verificar el recibo, no se recupera un precio histórico del bloque. Una cotización no disponible deja la fusión pendiente.
- **Incertidumbre tras envío.** Si falta el ID remoto de una orden aceptada, el sistema no puede demostrar que no existe; queda detenido para revisión. Las fusiones con hash conocido se concilian por recibo y nunca se vuelven a enviar automáticamente. Si no hay hash verificable, la parada permanece.
- **Liquidez y concentración.** La valoración exige profundidad completa de salida o usa cero. Los subyacentes cripto reconocidos se agrupan conservadoramente; otros activos desconocidos se agrupan por evento. No existe una matriz general de correlaciones ni cobertura entre mercados distintos.
- **Backtesting.** Snapshots REST no reconstruyen toda la microestructura. Se usa el primer libro observado después de la latencia, sin prioridad de cola. La comparación original es una aproximación de sus límites aplicada al nuevo ejecutor, no una reproducción de beneficios ficticios ni de estrategias desactivadas. Los FOK parciales solo se inyectan como estrés anómalo.
- **Seguimiento de varios días.** El universo operativo se limita a 20 mercados compatibles, renovado cada 15 minutos. La captura conserva 20 niveles por lado, a intervalos de diez segundos por mercado y en ejecuciones; no registra todos los eventos. La cantidad de gas es un supuesto configurable y necesita calibración antes de interpretar el resultado como estimación de costes reales. El informe paper acumula PnL de la cuenta y separa ese dato de la actividad del periodo seleccionado.
- **Telegram e informes.** Las métricas de riesgo son globales al modo de la base. El snapshot conserva las últimas 500 órdenes, 200 eventos y 1.000 observaciones para visualización; el historial completo permanece en SQLite. El trabajador lee una transacción coherente y no modifica la cuenta. Cada modo debe usar otra base.
- **Telegram.** Sin token y chat privado no se puede realizar una prueba real de recepción o entrega. Se verificó con transporte simulado, incluyendo rechazos y reintentos.
- **Operación privada.** El servicio escucha en loopback. El acceso remoto es por túnel SSH. No se preparó exposición pública ni certificados TLS de un dominio.

Los límites de riesgo son controles operativos, no garantías de pérdida máxima ante fallos de mercado, red o infraestructura.
