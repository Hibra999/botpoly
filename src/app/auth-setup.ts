import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { passwordHash } from "./auth.js";

// The one-time password is written only to a private file, never stdout/logs.
const password = randomBytes(24).toString("base64url");
const content = existsSync(".env")
  ? readFileSync(".env", "utf8")
  : readFileSync(".env.example", "utf8");
const hash = `DASHBOARD_PASSWORD_HASH=${passwordHash(password)}`;
writeFileSync(
  ".env",
  /^DASHBOARD_PASSWORD_HASH=.*$/m.test(content)
    ? content.replace(/^DASHBOARD_PASSWORD_HASH=.*$/m, hash)
    : `${content}\n${hash}\n`,
  { mode: 0o600 },
);
chmodSync(".env", 0o600);
writeFileSync(".dashboard-password", password + "\n", { mode: 0o600 });
chmodSync(".dashboard-password", 0o600);
console.log(
  "Acceso configurado. Lee la contraseña local en .dashboard-password. Las sesiones caducan a las 8 horas.",
);
