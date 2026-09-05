# Botpoly

Lee `INIT.md` antes de modificar arranque, configuración, riesgo o despliegue.

- Repositorio real: esta carpeta `Polymarket-bot/`, remoto `Hibra999/botpoly`, rama `main`. No operar sobre el Git del directorio padre.
- El usuario pidió commit y push después de cada cambio verificado. Agrupa los archivos de una misma modificación coherente y publica su commit.
- Node **24.20.0**, pnpm **10.32.1**, un workspace y un único `pnpm-lock.yaml`. Instalación con scripts desactivados. No reintroducir npm lockfiles.
- Arranque por `pnpm start`. `paper` y `backtest` no deben importar ni crear firmantes. `live` requiere evidencia revisada y activación explícita; ninguna prueba debe enviar órdenes reales.
- Toda estrategia automática pasa por `Engine` → reserva transaccional → ejecutor → confirmación → `Ledger`. Nunca registrar beneficios por señales ni liberar una reserva incierta.
- No borrar, reinicializar ni sustituir `.runtime/*.sqlite` para resolver una parada. Son persistentes y requieren revisión/reanudación autorizada.
- No registrar `.env`, `.dashboard-password`, sesiones, claves, credenciales CLOB ni URLs de Telegram. No incluirlos en capturas, informes, logs o mensajes de error.
- `src/services/trading-service.ts` conserva compatibilidad de lectura; sus mutaciones antiguas están desactivadas. Los scripts de rescate, depósitos y aprobaciones son manuales y ajenos al arranque.
- Verificar `pnpm test`, `pnpm typecheck`, `pnpm build` y la prueba pertinente. Cambios del dashboard requieren revisar escritorio/móvil y teclado. Cambios al importador requieren las pruebas Python documentadas.
- Los informes deben preservar procedencia, checksum, periodos, configuración, costes y limitaciones, incluso si el resultado es negativo o insuficiente. Nunca presentar el fixture sintético como rentabilidad real.
- Conserva la interfaz en español, el fondo oscuro y la paleta existente. Mantén feedback de comandos y estados vacíos. No añadir una activación de live al dashboard o a Telegram.
- La suite `test:integration` heredada consulta APIs públicas y puede reflejar contratos o servicios anteriores. No convertir una incompatibilidad externa en una prueba aparentemente exitosa mediante `catch` silencioso.
