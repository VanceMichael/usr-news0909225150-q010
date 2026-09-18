// 本机（无 Docker）重启恢复入口：embedded-postgres + scripts/restart-check.mjs。
import EmbeddedPostgres from "embedded-postgres";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const port = 55432;
const pg = new EmbeddedPostgres({
  databaseDir: "/tmp/embedded-pg-data",
  user: "navigation",
  password: "local-development-only",
  port,
  persistent: true,
});

async function main() {
  if (!existsSync("/tmp/embedded-pg-data")) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase("navigation");
  } catch (err) {
    if (!String(err?.message ?? err).includes("already exists")) throw err;
  }

  const child = spawn(process.execPath, ["scripts/restart-check.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: `postgres://navigation:local-development-only@127.0.0.1:${port}/navigation`,
      PORT: "18080",
    },
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  await pg.stop();
  process.exit(code ?? 1);
}

main().catch(async (err) => {
  console.error(err);
  await pg.stop().catch(() => {});
  process.exit(1);
});
