import "dotenv/config";
import postgres from "postgres";
import { runMigrations } from "../src/server/db/migrate";

/** Recreate the test database schema from scratch once per test run. */
export default async function setup() {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST is not set (see .env.example)");
  const sql = postgres(url, { onnotice: () => {} });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await sql`CREATE SCHEMA public`;
  await sql.end();
  await runMigrations(url);
}
