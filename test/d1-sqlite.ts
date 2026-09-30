/// <reference types="node" />
// Minimal D1 stand-in backed by Node's built-in SQLite, so tests run the real migration SQL.
// Implements only the parts of the D1 API the Worker uses.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Value = string | number | null;

class Statement {
  constructor(private db: DatabaseSync, private sql: string, private params: Value[] = []) {}
  bind(...params: Value[]) {
    return new Statement(this.db, this.sql, params);
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params) as T) ?? null;
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true, meta: {} };
  }
  async run() {
    return this.runSync();
  }
  runSync() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes) } };
  }
}

export function createTestD1(): { d1: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(import.meta.dirname, "..", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, file), "utf8"));
  }
  const d1 = {
    prepare: (sql: string) => new Statement(sqlite, sql),
    // D1 batches run as one transaction.
    batch: async (stmts: Statement[]) => {
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.runSync());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { d1: d1 as unknown as D1Database, sqlite };
}
