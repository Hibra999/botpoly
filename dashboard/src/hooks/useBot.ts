import { useCallback, useEffect, useRef, useState } from "react";
import type { Ledger } from "../../../src/engine/ledger";
import type { CommandName } from "../../../src/app/control";
export type Snapshot = ReturnType<Ledger["snapshot"]>;

export function useBot() {
  const [auth, setAuth] = useState<"loading" | "login" | "ready">("loading");
  const [data, setData] = useState<Snapshot | null>(null),
    [connected, setConnected] = useState(false);
  const [message, setMessage] = useState(""),
    [failed, setFailed] = useState(false),
    [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const busyRef = useRef(false);
  useEffect(() => {
    let dead = false,
      ws: WebSocket | undefined,
      retryTimer: ReturnType<typeof setTimeout>,
      attempts = 0;
    const connect = async () => {
      try {
        const session = await fetch("/api/session");
        if (dead) return;
        if (!session.ok) throw Error();
        if (!(await session.json()).authenticated) {
          setAuth("login");
          setData(null);
          return;
        }
        const response = await fetch("/api/status");
        if (dead) return;
        if (response.status === 401) {
          setAuth("login");
          setData(null);
          return;
        }
        if (!response.ok) throw Error();
        const value = await response.json();
        if (dead) return;
        setData(value);
        setAuth("ready");
        ws = new WebSocket(
          `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
        );
        ws.onopen = () => {
          attempts = 0;
          setConnected(true);
        };
        ws.onmessage = (event) => {
          try {
            const m = JSON.parse(event.data);
            if (m.type === "snapshot") setData(m.payload);
          } catch {
            setMessage("Respuesta del servidor inválida");
          }
        };
        ws.onclose = (event) => {
          setConnected(false);
          if (dead) return;
          if (event.code === 1008) {
            setAuth("login");
            setData(null);
          } else
            retryTimer = setTimeout(
              connect,
              Math.min(15000, 1000 * 2 ** attempts++),
            );
        };
      } catch {
        if (!dead) {
          setConnected(false);
          setMessage("No se pudo conectar con el bot. Reintentando…");
          retryTimer = setTimeout(connect, 3000);
        }
      }
    };
    void connect();
    return () => {
      dead = true;
      clearTimeout(retryTimer);
      ws?.close();
    };
  }, [generation]);
  const retry = useCallback(() => setGeneration((n) => n + 1), []);
  const login = async (password: string): Promise<string | null> => {
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) return (await r.json()).error ?? "Acceso denegado";
      setAuth("loading");
      setMessage("");
      retry();
      return null;
    } catch {
      return "No se pudo conectar. Inténtalo de nuevo.";
    }
  };
  const logout = async () => {
    await fetch("/api/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    setData(null);
    setAuth("login");
    retry();
  };
  const command = async (name: CommandName, payload?: unknown) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    const id = crypto.randomUUID();
    try {
      const r = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          command: name,
          ...(payload === undefined ? {} : { payload }),
        }),
      });
      const result = await r.json();
      setFailed(!r.ok || !result.ok);
      setMessage(result.message ?? result.error ?? "Respuesta desconocida");
      if (r.status === 401) {
        setAuth("login");
        setData(null);
      }
    } catch {
      setFailed(true);
      setMessage(
        "No se recibió confirmación. Comprueba el estado antes de repetir el comando.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return {
    auth,
    data,
    connected,
    message,
    failed,
    busy,
    login,
    logout,
    retry,
    command,
  };
}
