/**
 * 测试辅助：为每个测试进程拉起一个用户态 PostgreSQL（embedded-postgres），
 * 与生产使用同一镜像系（PG 17）、同一迁移与同一驱动，避免用模拟件
 * 掩盖真实的事务/锁行为。
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import EmbeddedPostgres from "embedded-postgres";

export interface TestPg {
  pg: EmbeddedPostgres;
  connectionString: string;
  stop: () => Promise<void>;
}

export async function startTestPg(name: string): Promise<TestPg> {
  const dir = join(tmpdir(), `seazone-test-${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });

  const port = 55000 + Math.floor(Math.random() * 4000);
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "worker",
    password: "test",
    port,
    persistent: false,
    // 沙箱基础镜像可能没有 en_US.UTF-8 locale。
    initdbFlags: ["--lc-messages=C"],
    postgresFlags: ["-c", "log_min_messages=warning"],
  });
  await pg.initialise();
  await pg.start();

  const connectionString =
    `postgres://worker:test@127.0.0.1:${port}/postgres`;
  return {
    pg,
    connectionString,
    stop: async () => {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 在独立子进程中执行 fn 的代码（用于真重启验证）。 */
export function childEvalUrl(code: string): string {
  const b64 = Buffer.from(code).toString("base64");
  return `data:text/javascript;base64,${b64}`;
}

export { once };
