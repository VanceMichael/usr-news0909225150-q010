// 本机（无 Docker）总验收：embedded-postgres + acceptance.sh 的全部四个步骤。
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

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: `postgres://navigation:local-development-only@127.0.0.1:${port}/navigation`,
        ENABLE_TEST_GATES: "1",
        PORT: "18080",
      },
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}

async function main() {
  if (!existsSync("/tmp/embedded-pg-data")) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase("navigation");
  } catch (err) {
    if (!String(err?.message ?? err).includes("already exists")) throw err;
  }
  try {
    await run("node", ["--test", "dist/test/geometry.test.js"]);
    await run("node", ["--test", "dist/test/integration.test.js"]);
    await run("node", ["scripts/fixture-smoke.mjs"]);
    await run("node", ["scripts/restart-check.mjs"]);
    console.log("\n本机全部验收通过");
  } finally {
    await pg.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
