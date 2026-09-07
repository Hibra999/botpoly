import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import type { Frame } from "./model.js";

const tables = [
  "meta",
  "orders",
  "fills",
  "positions",
  "reservations",
  "events",
  "settlements",
  "commands",
  "reports",
  "equity",
  "outbox",
  "statistics",
  "activity",
] as const;
export type Table = (typeof tables)[number];
/** Synchronous transactions deliberately never span an await. WAL + BEGIN IMMEDIATE
 * also serialize independent connections reserving the same capital. */
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON",
    );
    for (const table of tables)
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)))`,
      );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS recorded_books (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, market TEXT NOT NULL, data BLOB NOT NULL); CREATE INDEX IF NOT EXISTS recorded_books_time ON recorded_books(timestamp)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS equity_time ON equity(CAST(json_extract(data,'$.timestamp') AS INTEGER))",
    );
    this.db.exec("CREATE TABLE IF NOT EXISTS operation_slots (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, terminal_at INTEGER); CREATE INDEX IF NOT EXISTS operation_slots_terminal ON operation_slots(terminal_at)");
    const version = this.get<number>("meta", "schema");
    if (version !== undefined && version !== 1)
      throw new Error("Versión de base de datos incompatible");
    this.put("meta", "schema", 1);
  }
  get<T>(table: Table, id: string): T | undefined {
    const row = this.db
      .prepare(`SELECT data FROM ${table} WHERE id=?`)
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }
  all<T>(table: Table): T[] {
    return (
      this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data) as T);
  }
  recent<T>(table: Table, limit: number): T[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
      throw new Error("Límite de consulta inválido");
    return (
      this.db
        .prepare(`SELECT data FROM ${table} ORDER BY rowid DESC LIMIT ?`)
        .all(limit) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as T);
  }
  put(table: Table, id: string, data: unknown): void {
    this.db
      .prepare(
        `INSERT INTO ${table}(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(id, JSON.stringify(data));
  }
  insert(table: Table, id: string, data: unknown): boolean {
    return (
      this.db
        .prepare(`INSERT OR IGNORE INTO ${table}(id,data) VALUES (?,?)`)
        .run(id, JSON.stringify(data)).changes === 1
    );
  }
  delete(table: Table, id: string): void {
    this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  }
  recordBook(frame: Frame): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO recorded_books(id,timestamp,market,data) VALUES (?,?,?,?)",
      )
      .run(
        frame.id,
        frame.timestamp,
        frame.marketId,
        gzipSync(JSON.stringify(frame), { level: 1 }),
      );
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
}
