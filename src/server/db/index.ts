import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
/** A database handle or an open transaction; services accept either. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;

declare global {
  var __boekhoudenSql: ReturnType<typeof postgres> | undefined;
}

export function createDb(url: string): { db: Db; sql: ReturnType<typeof postgres> } {
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  return { db: drizzle(sql, { schema }), sql };
}

function getSql() {
  if (!globalThis.__boekhoudenSql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalThis.__boekhoudenSql = postgres(url, { max: 10, onnotice: () => {} });
  }
  return globalThis.__boekhoudenSql;
}

let cached: Db | undefined;
/** Lazily created app-wide database (reused across hot reloads in dev). */
export function getDb(): Db {
  if (!cached) cached = drizzle(getSql(), { schema });
  return cached;
}

export { schema };
