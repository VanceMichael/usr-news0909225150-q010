import type { PoolClient } from "pg";
import { MIGRATIONS } from "./schema.js";

/** 简单前向迁移：schema_migrations 记录已应用文件名，每个迁移在单事务内完成。 */
export async function runMigrations(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    );
  `);
  for (const migration of MIGRATIONS) {
    const { rows } = await client.query(
      "select 1 from schema_migrations where name = $1",
      [migration.name],
    );
    if (rows.length > 0) continue;
    await client.query("begin");
    try {
      await client.query(migration.sql);
      await client.query("insert into schema_migrations(name) values ($1)", [migration.name]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  }
}
