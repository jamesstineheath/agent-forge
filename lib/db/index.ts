import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

let _db: NeonHttpDatabase<typeof schema> | null = null;

/**
 * Lazy-initialized database connection.
 * Deferred so the build doesn't fail when DATABASE_URL is only available
 * at runtime in the Vercel environment.
 */
function getDb(): NeonHttpDatabase<typeof schema> {
  if (!_db) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set. Neon Postgres connection requires this environment variable."
      );
    }
    const sql = neon(process.env.DATABASE_URL);
    _db = drizzle(sql, { schema });
  }
  return _db;
}

/** Proxy that lazily initializes the database connection on first access. */
export const db = new Proxy({} as NeonHttpDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});
