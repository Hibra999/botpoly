import { useState, type FormEvent } from "react";
export function Login({
  onLogin,
}: {
  onLogin: (password: string) => Promise<string | null>;
}) {
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const message = await onLogin(password);
    setPassword("");
    setError(message ?? "");
    setBusy(false);
  };
  return (
    <main className="login-page">
      <div className="login-panel">
        <p className="brand">BOTPOLY</p>
        <p className="eyebrow">ESPACIO PRIVADO</p>
        <h1>Tu bot, bajo control.</h1>
        <p className="muted">
          Revisa operaciones, capital y límites de riesgo desde una sesión
          segura.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="password">Contraseña de acceso</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={512}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="primary" disabled={busy}>
            {busy ? "Verificando…" : "Entrar al dashboard"}
          </button>
          <p className="error-text" role="alert">
            {error}
          </p>
        </form>
        <p className="login-note">Acceso privado · sesión de 8 horas</p>
      </div>
      <div className="login-aside" aria-hidden="true">
        <span>YES</span>
        <i>+</i>
        <span>NO</span>
        <p>
          Una estrategia.
          <br />
          Cada ejecución, registrada.
        </p>
      </div>
    </main>
  );
}
