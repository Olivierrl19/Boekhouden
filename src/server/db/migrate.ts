import "dotenv/config";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./index";

export async function runMigrations(url: string) {
  const { db, sql } = createDb(url);
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
  } finally {
    await sql.end();
  }
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  // Neon's Vercel integration provides a direct (unpooled) URL; DDL is safest over a direct connection.
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    // First deploy before a database is connected: build the app anyway, migrate on the next deploy.
    console.warn("DATABASE_URL is niet ingesteld: migraties overgeslagen. Koppel een database en deploy opnieuw.");
    process.exit(0);
  }
  runMigrations(url).then(
    () => console.log("Migraties uitgevoerd"),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
