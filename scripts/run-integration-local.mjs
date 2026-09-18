// 本机（无 Docker）集成测试入口：embedded-postgres 拉起临时 PG，再跑 node:test。
// CI/验收容器内直接连接 compose 的 postgres，不经过本文件。
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

  const child = spawn(
    process.execPath,
    ["--test", "dist/test/integration.test.js"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: `postgres://navigation:local-development-only@127.0.0.1:${port}/navigation`,
        ENABLE_TEST_GATES: "1",
      },
    },
  );
  const code = await new Promise((resolve) => child.on("exit", resolve));
  await pg.stop();
  process.exit(code ?? 1);
}

main().catch(async (err) => {
  console.error(err);
  await pg.stop().catch(() => {});
  process.exit(1);
});
