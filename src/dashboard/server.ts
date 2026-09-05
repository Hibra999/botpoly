import http from "node:http";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Controller } from "../app/control.js";
import { Sessions } from "../app/auth.js";

let active: ReturnType<typeof createDashboard> | undefined;
export function createDashboard(
  controller: Controller,
  options: {
    passwordHash: string;
    port?: number;
    origin?: string;
    dist?: string;
    reports?: string;
  },
) {
  const sessions = new Sessions(options.passwordHash),
    port = options.port ?? 3001;
  let origin = options.origin ?? `http://127.0.0.1:${port}`;
  const dist = resolve(
    options.dist ??
      resolve(dirname(fileURLToPath(import.meta.url)), "../../dashboard/dist"),
  );
  const reports = resolve(options.reports ?? "reports");
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const allowed = (req: http.IncomingMessage, required = false) =>
    req.headers.host === new URL(origin).host &&
    (!req.headers.origin ? !required : req.headers.origin === origin);
  const json = (res: http.ServerResponse, code: number, value: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      if (!allowed(req))
        return json(res, 403, { error: "Origen no permitido" });
      const url = new URL(req.url ?? "/", origin);
      if (req.method === "GET" && url.pathname === "/health")
        return json(res, 200, { status: "ok" });
      if (req.method === "GET" && url.pathname === "/api/session")
        return json(res, 200, { authenticated: sessions.valid(req) });
      let body: unknown;
      if (req.method === "POST") {
        if (
          !allowed(req, true) ||
          req.headers["content-type"] !== "application/json"
        )
          return json(res, 403, { error: "Solicitud no permitida" });
        let text = "";
        for await (const chunk of req) {
          text += chunk;
          if (Buffer.byteLength(text) > 8192)
            return json(res, 413, { error: "Solicitud demasiado grande" });
        }
        try {
          body = JSON.parse(text);
        } catch {
          return json(res, 400, { error: "JSON inválido" });
        }
      }
      if (req.method === "POST" && url.pathname === "/api/login") {
        const token = sessions.login(
          (body as { password?: unknown })?.password,
        );
        if (!token)
          return json(res, 401, {
            error: "Acceso denegado. Revisa la contraseña o espera un minuto.",
          });
        res.setHeader(
          "Set-Cookie",
          `botpoly_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${origin.startsWith("https:") ? "; Secure" : ""}`,
        );
        return json(res, 200, { ok: true });
      }
      if (
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/reports/")
      ) {
        if (!sessions.valid(req))
          return json(res, 401, { error: "Sesión requerida" });
        if (req.method === "POST" && url.pathname === "/api/logout") {
          sessions.logout(req);
          res.setHeader(
            "Set-Cookie",
            "botpoly_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          );
          return json(res, 200, { ok: true });
        }
        if (req.method === "GET" && url.pathname === "/api/status")
          return json(res, 200, controller.engine.ledger.snapshot());
        if (req.method === "POST" && url.pathname === "/api/command") {
          try {
            return json(res, 200, await controller.execute(body));
          } catch {
            return json(res, 400, { error: "Comando inválido" });
          }
        }
        if (
          req.method === "GET" &&
          /^\/reports\/[a-zA-Z0-9_-]+\/(report\.html|result\.json|trades\.csv)$/.test(
            url.pathname,
          )
        ) {
          const relative = url.pathname.slice("/reports/".length),
            path = resolve(reports, relative);
          if (
            existsSync(path) &&
            realpathSync(path).startsWith(realpathSync(reports) + sep)
          ) {
            res.setHeader(
              "Content-Disposition",
              `attachment; filename="${relative.split("/").pop()}"`,
            );
            res.setHeader(
              "Content-Type",
              extname(path) === ".html"
                ? "text/html; charset=utf-8"
                : extname(path) === ".json"
                  ? "application/json"
                  : "text/csv; charset=utf-8",
            );
            res.end(readFileSync(path));
            return;
          }
        }
        return json(res, 404, { error: "No encontrado" });
      }
      if (req.method !== "GET")
        return json(res, 405, { error: "Método no permitido" });
      const requested = resolve(dist, "." + decodeURIComponent(url.pathname));
      if (!requested.startsWith(dist + sep) && requested !== dist)
        return json(res, 403, { error: "Ruta no permitida" });
      const file =
        existsSync(requested) && statSync(requested).isFile()
          ? requested
          : resolve(dist, "index.html");
      if (!existsSync(file))
        return json(res, 404, {
          error: "Construye el dashboard con pnpm build",
        });
      if (!realpathSync(file).startsWith(realpathSync(dist) + sep))
        return json(res, 403, { error: "Ruta no permitida" });
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
      };
      res.writeHead(200, {
        "Content-Type": types[extname(file)] ?? "application/octet-stream",
      });
      res.end(readFileSync(file));
    } catch {
      if (!res.headersSent) json(res, 500, { error: "Error interno" });
      else res.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on("upgrade", (req, socket, head) => {
    if (
      req.url !== "/ws" ||
      !allowed(req, true) ||
      !sessions.valid(req) ||
      wss.clients.size >= 20
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  wss.on("connection", (ws, req) => {
    let busy = false,
      lastCommand = 0;
    const send = (value: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
    };
    send({ type: "snapshot", payload: controller.engine.ledger.snapshot() });
    ws.on("error", () => {});
    ws.on("message", async (data) => {
      if (!sessions.valid(req)) return ws.close(1008, "Sesión caducada");
      if (busy || Date.now() - lastCommand < 250)
        return send({
          type: "error",
          message: "Espera la confirmación anterior",
        });
      busy = true;
      lastCommand = Date.now();
      try {
        send({
          type: "result",
          payload: await controller.execute(JSON.parse(data.toString())),
        });
      } catch {
        send({ type: "error", message: "Comando inválido" });
      } finally {
        busy = false;
      }
    });
    const timer = setInterval(() => {
      if (!sessions.valid(req)) return ws.close(1008, "Sesión caducada");
      if (ws.bufferedAmount > 1e6)
        return ws.close(1008, "Cliente demasiado lento");
      send({ type: "snapshot", payload: controller.engine.ledger.snapshot() });
    }, 2000);
    ws.on("close", () => clearInterval(timer));
  });
  return {
    server,
    sessions,
    start: () =>
      new Promise<void>((resolve) =>
        server.listen(port, "127.0.0.1", () => {
          if (!options.origin && port === 0)
            origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
          resolve();
        }),
      ),
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
export async function startDashboard(
  controller: Controller,
  options: Parameters<typeof createDashboard>[1],
) {
  active = createDashboard(controller, options);
  await active.start();
  return active.server;
}
export async function stopDashboard(): Promise<void> {
  await active?.close();
  active = undefined;
}
