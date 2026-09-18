/**
 * Compose 验收脚本：对容器化 PostgreSQL（postgres:17-alpine）执行
 * 端到端验收，覆盖：跨午夜有效期、撤销更正、边界相切、并发发布、
 * 事务失败、服务重启恢复。
 *
 * 一条命令：
 *   docker compose up --build --abort-on-container-exit acceptance
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Db, FaultInjectedError } from "../src/db.js";
import type { BatchInput, DecisionRequest, NoticeInput } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL");
const db = new Db({ connectionString });

const box = (
  lon0: number, lat0: number, lon1: number, lat1: number,
): NoticeInput["polygon"] => [
  [lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0],
];
const batch = (batch_ref: string, ops: BatchInput["ops"]): BatchInput => ({ batch_ref, ops });
const pub = (notice: NoticeInput): BatchInput["ops"][number] => ({ op: "publish", notice });
const rev = (notice_id: string): BatchInput["ops"][number] => ({ op: "revoke", notice_id });

async function reset(): Promise<void> {
  await db.pool.query(
    `TRUNCATE decisions, decision_snapshot, notice_revocations, notices, notice_batches
     RESTART IDENTITY CASCADE`,
  );
}

const checks: Array<[string, () => Promise<void>]> = [];
const check = (name: string, fn: () => Promise<void>) => checks.push([name, fn]);

// 1. 跨午夜有效期（半开区间）。
check("跨午夜有效期", async () => {
  await db.publishBatch(batch("A-cross", [{
    op: "publish",
    notice: {
      notice_id: "A-CROSS", issuer: "AUTH-M", sequence: 1, revision: 1, replaces: null,
      valid_from: "2026-09-06T23:00:00+08:00",
      valid_until: "2026-09-07T01:00:00+08:00",
      polygon: box(120.0, 35.0, 121.0, 36.0),
    },
  }]));
  const req: DecisionRequest = {
    decision_id: "A-1", idempotency_key: "a-1",
    departure_at: "2026-09-06T23:30:00+08:00", speed_knots: 60,
    route: [[120.2, 35.2], [120.8, 35.8]],
  };
  const { result } = await db.createDecision(req);
  assert.equal(result.status, "restricted");
  assert.ok(result.first_intersection!.exits_at <= "2026-09-06T17:00:00.000Z");
});

// 2. 撤销更正：原通告恢复生效。
check("撤销更正后原通告恢复", async () => {
  const v1: NoticeInput = {
    notice_id: "A-N10", issuer: "AUTH-T", sequence: 10, revision: 1, replaces: null,
    valid_from: "2026-09-06T00:00:00+08:00", valid_until: "2026-09-08T00:00:00+08:00",
    polygon: box(119.1, 39.0, 119.4, 39.2),
  };
  const v2: NoticeInput = {
    notice_id: "A-N10R2", issuer: "AUTH-T", sequence: 11, revision: 2, replaces: "A-N10",
    valid_from: "2026-09-06T06:00:00+08:00", valid_until: "2026-09-07T20:00:00+08:00",
    // 更正件几何移到航线之外，以区分"替代时段"与"原几何"。
    polygon: box(119.6, 39.0, 119.9, 39.2),
  };
  await db.publishBatch(batch("A-b1", [pub(v1)]));
  await db.publishBatch(batch("A-b2", [pub(v2)]));
  const req: DecisionRequest = {
    decision_id: "A-2", idempotency_key: "a-2",
    departure_at: "2026-09-06T07:00:00+08:00", speed_knots: 12,
    route: [[118.9, 39.1], [119.2, 39.1]],
  };
  // 更正几何不含航线但替代了旧版时段 => 07:00 旧版被替代 => clear。
  assert.equal((await db.createDecision(req)).result.status, "clear");
  // 撤销更正 => 旧版在 07:00 恢复生效 => restricted。
  await db.publishBatch(batch("A-b3", [rev("A-N10R2")]));
  const again = await db.createDecision({ ...req, decision_id: "A-2B", idempotency_key: "a-2b" });
  assert.equal(again.result.status, "restricted");
  assert.deepEqual(again.result.basis.map((b) => b.notice_id), ["A-N10"]);
});

// 3. 边界相切 => needs_review。
check("边界相切 needs_review", async () => {
  await db.publishBatch(batch("A-tan", [pub({
    notice_id: "A-TAN", issuer: "AUTH-X", sequence: 1, revision: 1, replaces: null,
    valid_from: "2026-09-10T00:00:00+08:00", valid_until: "2026-09-11T00:00:00+08:00",
    polygon: box(121.0, 30.0, 121.2, 30.2),
  })]));
  const { result } = await db.createDecision({
    decision_id: "A-3", idempotency_key: "a-3",
    departure_at: "2026-09-10T08:00:00+08:00", speed_knots: 30,
    route: [[120.8, 29.8], [121.0, 30.0], [120.8, 30.2]],
  });
  assert.equal(result.status, "needs_review");
  assert.equal(result.first_intersection!.kind, "boundary_tangent");
});

// 4. 并发发布：快照不混合 + 重复提交只有一份。
check("并发发布无混合版本", async () => {
  const a: NoticeInput = {
    notice_id: "A-LA", issuer: "AUTH-L", sequence: 1, revision: 1, replaces: null,
    valid_from: "2026-09-10T00:00:00+08:00", valid_until: "2026-09-11T00:00:00+08:00",
    polygon: box(125.0, 35.0, 125.2, 35.2),
  };
  const b: NoticeInput = {
    notice_id: "A-LB", issuer: "AUTH-L", sequence: 2, revision: 2, replaces: "A-LA",
    valid_from: "2026-09-10T00:00:00+08:00", valid_until: "2026-09-11T00:00:00+08:00",
    polygon: box(125.0, 35.0, 125.2, 35.2),
  };
  const far: DecisionRequest = {
    decision_id: "A-X", idempotency_key: "a-x",
    departure_at: "2026-09-10T08:00:00+08:00", speed_knots: 30,
    route: [[100, 10], [101, 10]],
  };
  const decisions = [];
  for (let i = 0; i < 6; i++) {
    decisions.push(db.createDecision({ ...far, decision_id: `A-C${i}`, idempotency_key: `a-c${i}` }));
  }
  await Promise.all([db.publishBatch(batch("A-linked", [pub(a), pub(b)])), ...decisions]);
  const { rows } = await db.pool.query(
    `SELECT d.result->'snapshot'->'notice_versions' AS versions
       FROM decisions d WHERE d.decision_id LIKE 'A-C%'`,
  );
  for (const r of rows) {
    const ids = (r.versions as Array<{ notice_id: string }>).map((x) => x.notice_id);
    if (ids.includes("A-LB")) assert.ok(ids.includes("A-LA"), "禁止混合版本");
  }
});

// 5. 事务失败回滚 + 幂等。
check("事务失败不留痕且可重试", async () => {
  await db.publishBatch(batch("A-fault", [pub({
    notice_id: "A-FT", issuer: "AUTH-F", sequence: 1, revision: 1, replaces: null,
    valid_from: "2026-09-10T00:00:00+08:00", valid_until: "2026-09-11T00:00:00+08:00",
    polygon: box(1, 1, 2, 2),
  })]));
  const req: DecisionRequest = {
    decision_id: "A-5", idempotency_key: "a-5",
    departure_at: "2026-09-10T08:00:00+08:00", speed_knots: 30,
    route: [[100, 10], [101, 10]],
  };
  await assert.rejects(
    db.createDecision(req, { fault: "abort_after_snapshot" }),
    (e: unknown) => e instanceof FaultInjectedError,
  );
  assert.equal(await db.getDecision("A-5"), null);
  const first = await db.createDecision(req);
  const second = await db.createDecision(req);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  const { rows } = await db.pool.query("SELECT count(*)::int c FROM decisions WHERE decision_id='A-5'");
  assert.equal(rows[0].c, 1);
});

// 6. 服务进程重启后按判定 ID 复现。
check("服务重启后按 ID 复现", async () => {
  await db.publishBatch(batch("A-restart", [pub({
    notice_id: "A-RS", issuer: "AUTH-R", sequence: 1, revision: 1, replaces: null,
    valid_from: "2026-09-06T00:00:00+08:00", valid_until: "2026-09-08T00:00:00+08:00",
    polygon: box(119.1, 39.0, 119.4, 39.2),
  })]));
  const req: DecisionRequest = {
    decision_id: "A-6", idempotency_key: "a-6",
    departure_at: "2026-09-06T05:30:00+08:00", speed_knots: 12,
    route: [[118.9, 39.1], [119.2, 39.1], [119.5, 39.1]],
  };
  const { result: original } = await db.createDecision(req);

  const port = 8091;
  const base = `http://127.0.0.1:${port}`;
  const start = () => spawn(process.execPath, [join(root, "dist", "server.js")], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  const waitReady = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) return;
      } catch { /* 等待 */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("服务未就绪");
  };

  const s1 = start();
  await waitReady();
  s1.kill("SIGKILL");
  await once(s1, "exit");

  const s2 = start();
  await waitReady();
  const res = await fetch(`${base}/decisions/A-6`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, original.status);
  s2.kill("SIGTERM");
  await once(s2, "exit");
});

async function main(): Promise<void> {
  await db.migrate();
  await reset();
  let passed = 0;
  for (const [name, fn] of checks) {
    process.stdout.write(`▶ ${name} … `);
    try {
      await fn();
      console.log("PASS");
      passed++;
    } catch (err) {
      console.log("FAIL");
      console.error(err);
      process.exitCode = 1;
      break;
    }
  }
  await db.close();
  if (process.exitCode === 1) {
    console.log(`\n验收失败：${passed}/${checks.length}`);
  } else {
    console.log(`\n验收通过：${passed}/${checks.length}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
