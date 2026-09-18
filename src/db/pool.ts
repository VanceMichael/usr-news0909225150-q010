import pg from "pg";

const { Pool } = pg;

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://navigation:local-development-only@localhost:5432/navigation";

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export interface Client extends pg.PoolClient {}

export async function withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
