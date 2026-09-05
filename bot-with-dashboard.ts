import "dotenv/config";
import { main } from "./src/app/main.js";

main().catch(() => {
  console.error(
    "Botpoly no pudo arrancar. Revisa Node 24, la configuración y el acceso con pnpm auth:setup.",
  );
  process.exitCode = 1;
});
