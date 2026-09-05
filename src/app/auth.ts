import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function passwordHash(password: string): string {
  if (password.length < 16 || password.length > 512)
    throw new Error("Contraseña entre 16 y 512 caracteres");
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
}
export class Sessions {
  private sessions = new Map<string, number>();
  private failures: number[] = [];
  constructor(
    private hash: string,
    private now: () => number = Date.now,
  ) {
    if (!/^[a-f0-9]{32}:[a-f0-9]{64}$/.test(hash))
      throw new Error("Ejecuta pnpm auth:setup para configurar el acceso");
  }
  login(password: unknown): string | null {
    this.failures = this.failures.filter((t) => this.now() - t < 60000);
    if (
      this.failures.length >= 5 ||
      typeof password !== "string" ||
      password.length > 512
    )
      return null;
    const [salt, digest] = this.hash.split(":");
    if (
      !timingSafeEqual(
        scryptSync(password, salt, 32),
        Buffer.from(digest, "hex"),
      )
    ) {
      this.failures.push(this.now());
      return null;
    }
    for (const [token, expiry] of this.sessions)
      if (expiry < this.now()) this.sessions.delete(token);
    if (this.sessions.size >= 20)
      this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, this.now() + 8 * 3600000);
    return token;
  }
  token(req: IncomingMessage): string {
    return (
      /(?:^|;\s*)botpoly_session=([a-f0-9]{64})(?:;|$)/.exec(
        req.headers.cookie ?? "",
      )?.[1] ?? ""
    );
  }
  valid(req: IncomingMessage): boolean {
    return (this.sessions.get(this.token(req)) ?? 0) > this.now();
  }
  logout(req: IncomingMessage): void {
    this.sessions.delete(this.token(req));
  }
}
