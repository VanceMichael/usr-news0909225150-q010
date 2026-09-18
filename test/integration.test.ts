/**
 * 集成测试：真实 PostgreSQL 17（用户态二进制）+ 真实 HTTP 服务，
 * 覆盖：跨午夜有效期、撤销更正、边界相切、并发发布、事务失败、
 * 重启恢复（服务进程重启 + 数据库重启 + 冻结快照重放）。
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import assert from "node:assert/strict";
import { describe, test, before, after, beforeEach } from "node:test";
import EmbeddedPostgres from "embedded-postgres";
import { Db, FaultInjectedError } from "../src/db.js";
import { createApp } from "../src/app.js";
import type { BatchInput, DecisionRequest, NoticeInput } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

interface PgInstance {
  cs: string;
  stop: () => Promise<void>;
}

async function startPersistentPg(dir: string, port: number): Promise<PgInstance> {
  rmSync(dir, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "worker",
    password: "test",
    port,
    persistent: true,
    initdbFlags: ["--lc-messages=C"],
    postgresFlags: ["-c", "log_min_messages=warning"],
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  return {
    cs: `postgres://worker:test@127.0.0.1:${port}/postgres`,
    stop: () => pg.stop(),
  };
}

/** 在已存在的数据目录上重新拉起 PG（模拟数据库重启）。 */
async function restartPersistentPg(dir: string, port: number): Promise<PgInstance> {
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "worker",
    password: "test",
    port,
    persistent: true,
    initdbFlags: ["--lc-messages=C"],
    postgresFlags: ["-c", "log_min_messages=warning"],
    onLog: () => {},
  });
  await pg.start();
  return {
    cs: `postgres://worker:test@127.0.0.1:${port}/postgres`,
    stop: () => pg.stop(),
  };
}

// ----------------------------- 测试数据 --------------------------------

const box = (
  lon0: number, lat0: number, lon1: number, lat1: number,
): NoticeInput["polygon"] => [
  [lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0],
];

const nCross: NoticeInput = {
  notice_id: "N-CROSS", issuer: "AUTH-M", sequence: 1, revision: 1, replaces: null,
  valid_from: "2026-09-06T23:00:00+08:00",
  valid_until: "2026-09-07T01:00:00+08:00",
  polygon: box(120.0, 35.0, 121.0, 36.0),
};

const nBeforeMidnight: NoticeInput = {
  notice_id: "N-EARLY", issuer: "AUTH-M", sequence: 2, revision: 1, replaces: null,
  valid_from: "2026-09-06T22:00:00+08:00",
  valid_until: "2026-09-06T23:00:00+08:00",
  polygon: box(120.0, 35.0, 121.0, 36.0),
};

const nStartsAtMidnight: NoticeInput = {
  notice_id: "N-ZERO", issuer: "AUTH-M", sequence: 3, revision: 1, replaces: null,
  valid_from: "2026-09-07T00:00:00+08:00",
  valid_until: "2026-09-07T01:00:00+08:00",
  polygon: box(120.0, 35.0, 121.0, 36.0),
};

// 船只 23:30 出发，在区域内停留跨过午夜（约 50 分钟航程）。
const crossMidnightRoute: DecisionRequest = {
  decision_id: "D-CROSS",
  idempotency_key: "key-cross",
  departure_at: "2026-09-06T23:30:00+08:00",
  speed_knots: 60,
  route: [[120.2, 35.2], [120.8, 35.8]],
};

const n10 = (): NoticeInput => ({
  notice_id: "N-10", issuer: "AUTH-T", sequence: 10, revision: 1, replaces: null,
  valid_from: "2026-09-06T00:00:00+08:00",
  valid_until: "2026-09-07T23:59:59+08:00",
  polygon: box(119.10, 39.00, 119.40, 39.20),
});

const n10r2 = (): NoticeInput => ({
  notice_id: "N-10-R2", issuer: "AUTH-T", sequence: 11, revision: 2, replaces: "N-10",
  valid_from: "2026-09-06T06:00:00+08:00",
  valid_until: "2026-09-07T20:00:00+08:00",
  polygon: box(119.15, 39.05, 119.35, 39.18),
});

const fixtureRoute: DecisionRequest = {
  decision_id: "D-01",
  idempotency_key: "route-check-0001",
  departure_at: "2026-09-06T05:30:00+08:00",
  speed_knots: 12,
  route: [[118.9, 39.1], [119.2, 39.1], [119.5, 39.1]],
};

const nTangent: NoticeInput = {
  notice_id: "N-TAN", issuer: "AUTH-X", sequence: 1, revision: 1, replaces: null,
  valid_from: "2026-09-10T00:00:00+08:00",
  valid_until: "2026-09-11T00:00:00+08:00",
  polygon: box(121.0, 30.0, 121.2, 30.2),
};

// 航线 V 形擦过西南角顶点 (121.0, 30.0)，两段均不进入内部。
const tangentRoute: DecisionRequest = {
  decision_id: "D-TAN",
  idempotency_key: "key-tan",
  departure_at: "2026-09-10T08:00:00+08:00",
  speed_knots: 30,
  route: [[120.8, 29.8], [121.0, 30.0], [120.8, 30.2]],
};

// 沿西侧边界航行：边界属于区域 => restricted。
const edgeRoute: DecisionRequest = {
  decision_id: "D-EDGE",
  idempotency_key: "key-edge",
  departure_at: "2026-09-10T08:00:00+08:00",
  speed_knots: 30,
  route: [[121.0, 29.9], [121.0, 30.1]],
};

const farRoute: DecisionRequest = {
  decision_id: "D-FAR",
  idempotency_key: "key-far",
  departure_at: "2026-09-10T08:00:00+08:00",
  speed_knots: 30,
  route: [[100.0, 10.0], [101.0, 10.0]],
};

const batch = (batch_ref: string, ops: BatchInput["ops"]): BatchInput => ({ batch_ref, ops });
const pub = (notice: NoticeInput): BatchInput["ops"][number] => ({ op: "publish", notice });
const rev = (notice_id: string): BatchInput["ops"][number] => ({ op: "revoke", notice_id });

// ------------------------------ 主测试 ---------------------------------

let pg: PgInstance;
let db: Db;

before(async () => {
  const port = 56000 + Math.floor(Math.random() * 3000);
  pg = await startPersistentPg(join(tmpdir(), `seazone-int-${process.pid}`), port);
  db = new Db({ connectionString: pg.cs });
  await db.migrate();
});

after(async () => {
  await db.close();
  await pg.stop();
});

async function truncate(): Promise<void> {
  await db.pool.query(
    `TRUNCATE decisions, decision_snapshot, notice_revocations, notices, notice_batches
     RESTART IDENTITY CASCADE`,
  );
}

let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}-${Date.now() % 100000}`;

describe("有效期：跨午夜与半开区间", () => {
  beforeEach(truncate);

  test("通告有效期跨过午夜、船只在区域内跨越午夜 => restricted", async () => {
    await db.publishBatch(batch("B-cross", [pub(nCross)]));
    const { result } = await db.createDecision(crossMidnightRoute);
    assert.equal(result.status, "restricted");
    assert.deepEqual(result.basis.map((b) => b.notice_id), ["N-CROSS"]);
    // 进入时刻不早于通告生效、离开时刻不晚于失效。
    assert.equal(result.first_intersection!.enters_at, "2026-09-06T15:30:00.000Z");
    assert.ok(
      result.first_intersection!.exits_at <= "2026-09-06T17:00:00.000Z",
      "半开区间：01:00 失效时刻不得计入",
    );
  });

  test("有效期在船到之前就结束 => clear（半开上界）", async () => {
    await db.publishBatch(batch("B-early", [pub(nBeforeMidnight)]));
    const { result } = await db.createDecision({
      ...crossMidnightRoute, decision_id: "D-CROSS-2", idempotency_key: "key-cross-2",
    });
    assert.equal(result.status, "clear");
    assert.equal(result.first_intersection, null);
  });

  test("通告 00:00 生效，船已在区内 => restricted，进入时刻=生效时刻", async () => {
    await db.publishBatch(batch("B-zero", [pub(nStartsAtMidnight)]));
    const { result } = await db.createDecision({
      ...crossMidnightRoute, decision_id: "D-CROSS-3", idempotency_key: "key-cross-3",
    });
    assert.equal(result.status, "restricted");
    // 23:30 船已在区域内，23:30–24:00 通告未生效；00:00 起进入禁入状态。
    assert.equal(result.first_intersection!.enters_at, "2026-09-06T16:00:00.000Z");
    assert.deepEqual(result.basis.map((b) => b.notice_id), ["N-ZERO"]);
  });
});

describe("版本关系：更正与撤销", () => {
  beforeEach(truncate);

  test("更正发布后替代原通告，依据指向 revision 2", async () => {
    await db.publishBatch(batch("B-v1", [pub(n10())]));
    const before = await db.createDecision({ ...fixtureRoute, idempotency_key: unique("k") });
    assert.equal(before.result.status, "restricted");
    assert.deepEqual(before.result.basis.map((b) => b.revision), [1]);

    await db.publishBatch(batch("B-v2", [pub(n10r2())]));
    const after = await db.createDecision({
      ...fixtureRoute, decision_id: "D-02", idempotency_key: unique("k"),
    });
    assert.equal(after.result.status, "restricted");
    assert.deepEqual(after.result.basis.map((b) => b.notice_id), ["N-10-R2"]);
    assert.equal(after.result.basis[0]!.replaces, "N-10");
    // 快照同时冻结两份版本及其状态，可复核替代关系。
    const versions = new Map(after.result.snapshot.notice_versions.map((v) => [v.notice_id, v]));
    assert.equal(versions.get("N-10")!.revision, 1);
    assert.equal(versions.get("N-10-R2")!.revision, 2);
    assert.deepEqual(after.result.snapshot.batch_refs, ["B-v1", "B-v2"]);
  });

  test("撤销更正后原通告在其自身有效期内重新生效", async () => {
    await db.publishBatch(batch("B-v1", [pub(n10())]));
    await db.publishBatch(batch("B-v2", [pub(n10r2())]));
    await db.publishBatch(batch("B-revoke-r2", [rev("N-10-R2")]));

    const { result } = await db.createDecision({
      ...fixtureRoute, decision_id: "D-03", idempotency_key: unique("k"),
    });
    assert.equal(result.status, "restricted");
    assert.deepEqual(result.basis.map((b) => b.notice_id), ["N-10"]);
    const versions = new Map(result.snapshot.notice_versions.map((v) => [v.notice_id, v]));
    // 撤销只点名更正件：更正 revoked，原件 active。
    assert.equal(versions.get("N-10-R2")!.status, "revoked");
    assert.equal(versions.get("N-10")!.status, "active");
  });

  test("撤销原件不影响已生效的更正件", async () => {
    await db.publishBatch(batch("B-v1", [pub(n10())]));
    await db.publishBatch(batch("B-v2", [pub(n10r2())]));
    await db.publishBatch(batch("B-revoke-v1", [rev("N-10")]));

    const { result } = await db.createDecision({
      ...fixtureRoute, decision_id: "D-04", idempotency_key: unique("k"),
    });
    assert.equal(result.status, "restricted");
    assert.deepEqual(result.basis.map((b) => b.notice_id), ["N-10-R2"]);
  });

  test("船在区内跨越更正生效时刻：首个依据为旧版，区间在生效时刻截断，basis 记录接管版本", async () => {
    // 两版几何相同；v1 00:00 起、v2（更正）06:00 起。船 05:30 出发，
    // 约 05:58 进入区域，在区内持续到 06:00 之后。
    const v1: NoticeInput = {
      notice_id: "N-TAKE-1", issuer: "AUTH-V", sequence: 1, revision: 1, replaces: null,
      valid_from: "2026-09-06T00:00:00+08:00",
      valid_until: "2026-09-07T00:00:00+08:00",
      polygon: box(119.0, 39.0, 119.5, 39.3),
    };
    const v2: NoticeInput = {
      notice_id: "N-TAKE-2", issuer: "AUTH-V", sequence: 2, revision: 2, replaces: "N-TAKE-1",
      valid_from: "2026-09-06T06:00:00+08:00",
      valid_until: "2026-09-07T00:00:00+08:00",
      polygon: box(119.0, 39.0, 119.5, 39.3),
    };
    await db.publishBatch(batch("B-v1", [pub(v1), pub(v2)]));
    const { result } = await db.createDecision({
      decision_id: "D-TAKE", idempotency_key: unique("k"),
      departure_at: "2026-09-06T05:30:00+08:00", speed_knots: 10,
      route: [[118.9, 39.1], [119.6, 39.1]],
    });
    assert.equal(result.status, "restricted");
    // 进入在 06:00 之前，旧版是首个生效依据；离开时刻恰为更正生效时刻。
    assert.ok(
      result.first_intersection!.enters_at >= "2026-09-05T21:57:00.000Z" &&
        result.first_intersection!.enters_at < "2026-09-05T22:00:00.000Z",
      `进入时刻异常：${result.first_intersection!.enters_at}`,
    );
    assert.equal(result.first_intersection!.exits_at, "2026-09-05T22:00:00.000Z");
    assert.deepEqual(result.basis.map((b) => b.notice_id), ["N-TAKE-1", "N-TAKE-2"]);
    assert.ok(result.review_notes.some((n) => n.includes("替代")));
  });

  test("recheck：依据被撤销后历史结论标记 stale 并给出差异", async () => {
    await db.publishBatch(batch("B-v1", [pub(n10())]));
    const { result: original } = await db.createDecision({
      ...fixtureRoute, decision_id: "D-05", idempotency_key: unique("k"),
    });
    assert.equal(original.status, "restricted");

    await db.publishBatch(batch("B-revoke", [rev("N-10")]));
    const outcome = await db.recheckDecision("D-05");
    assert.ok(outcome);
    assert.equal(outcome.stale, true);
    assert.equal(outcome.result.status, "stale");
    assert.ok(outcome.result.staleness!.difference.some((d) => d.includes("状态变化")));
    // 历史行本身不被改写。
    const stored = await db.getDecision("D-05");
    assert.equal(stored!.status, "restricted");
  });

  test("recheck：无关新通告不构成 stale", async () => {
    await db.publishBatch(batch("B-tan", [pub(nTangent)]));
    await db.createDecision({ ...farRoute, decision_id: "D-06", idempotency_key: unique("k") });

    const unrelated: NoticeInput = {
      notice_id: "N-OTHER", issuer: "AUTH-Z", sequence: 1, revision: 1, replaces: null,
      valid_from: "2026-09-10T00:00:00+08:00",
      valid_until: "2026-09-11T00:00:00+08:00",
      polygon: box(130.0, 40.0, 130.2, 40.2),
    };
    await db.publishBatch(batch("B-other", [pub(unrelated)]));
    const outcome = await db.recheckDecision("D-06");
    assert.equal(outcome!.stale, false);
    assert.equal(outcome!.result.status, "clear");
  });
});

describe("边界规则：相切与沿边", () => {
  beforeEach(truncate);

  test("V 形航线单点擦过顶点 => needs_review / boundary_tangent", async () => {
    await db.publishBatch(batch("B-tan", [pub(nTangent)]));
    const { result } = await db.createDecision(tangentRoute);
    assert.equal(result.status, "needs_review");
    assert.equal(result.first_intersection!.kind, "boundary_tangent");
    assert.equal(result.first_intersection!.segment_index, 0);
    assert.equal(result.first_intersection!.entry.lon, 121.0);
    assert.equal(result.first_intersection!.entry.lat, 30.0);
    assert.equal(
      result.first_intersection!.enters_at, result.first_intersection!.exits_at,
      "相切为零时长单点接触",
    );
    assert.deepEqual(result.basis.map((b) => b.notice_id), ["N-TAN"]);
    assert.ok(result.review_notes[0]?.includes("相切"));
  });

  test("沿边界航行属于进入区域 => restricted", async () => {
    await db.publishBatch(batch("B-tan", [pub(nTangent)]));
    const { result } = await db.createDecision(edgeRoute);
    assert.equal(result.status, "restricted");
    assert.equal(result.first_intersection!.kind, "inside");
    assert.ok(result.first_intersection!.entry.lat < result.first_intersection!.exit.lat);
  });

  test("7 位小数精度：顶点在容差外的擦边不算相切 => clear", async () => {
    // 航线在边界南侧 0.000001 度（约 11 厘米）处经过——超出 7 位小数容差，
    // 四舍五入后仍不与边界重合。
    const route: DecisionRequest = {
      decision_id: "D-NEAR", idempotency_key: unique("k"),
      departure_at: "2026-09-10T08:00:00+08:00", speed_knots: 30,
      route: [[120.8, 29.8], [121.0, 29.999999], [120.8, 30.2]],
    };
    await db.publishBatch(batch("B-tan", [pub(nTangent)]));
    const { result } = await db.createDecision(route);
    assert.equal(result.status, "clear");
  });
});

describe("并发：批次原子性与混合版本", () => {
  beforeEach(truncate);

  test("判定与发布并发：每个快照要么不含新批次、要么含整批，绝不混合", async () => {
    await db.publishBatch(batch("B-base", [pub(nTangent)]));

    // 新批次含两份通告，第二份引用第一份；若出现混合版本，
    // 快照中会看到引用者却看不到被引用者。
    const linkedA: NoticeInput = {
      notice_id: "N-LINK-A", issuer: "AUTH-L", sequence: 1, revision: 1, replaces: null,
      valid_from: "2026-09-10T00:00:00+08:00", valid_until: "2026-09-11T00:00:00+08:00",
      polygon: box(125.0, 35.0, 125.2, 35.2),
    };
    const linkedB: NoticeInput = {
      notice_id: "N-LINK-B", issuer: "AUTH-L", sequence: 2, revision: 2, replaces: "N-LINK-A",
      valid_from: "2026-09-10T00:00:00+08:00", valid_until: "2026-09-11T00:00:00+08:00",
      polygon: box(125.0, 35.0, 125.2, 35.2),
    };

    const decisions: Promise<unknown>[] = [];
    for (let i = 0; i < 8; i++) {
      decisions.push(db.createDecision({
        ...farRoute, decision_id: `D-CONC-${i}`, idempotency_key: unique("kc"),
      }));
    }
    const publish = db.publishBatch(batch("B-linked", [pub(linkedA), pub(linkedB)]));
    const results = await Promise.all([publish, ...decisions]) as unknown as Array<{ result?: { snapshot: { notice_versions: Array<{ notice_id: string }>; batch_refs: string[] } } }>;

    for (const r of results.slice(1)) {
      const ids = new Set(r.result!.snapshot.notice_versions.map((v) => v.notice_id));
      if (ids.has("N-LINK-B")) {
        assert.ok(ids.has("N-LINK-A"), "看到 revision 2 就必须看到其 revision 1（禁止混合版本）");
        assert.ok(r.result!.snapshot.batch_refs.includes("B-linked"));
      } else {
        assert.ok(!r.result!.snapshot.batch_refs.includes("B-linked"));
      }
    }

    // 批次确实完整落盘。
    const { rows } = await db.pool.query(
      `SELECT notice_id FROM notices WHERE notice_id IN ('N-LINK-A','N-LINK-B') ORDER BY notice_id`,
    );
    assert.deepEqual(rows.map((x) => x.notice_id), ["N-LINK-A", "N-LINK-B"]);
  });

  test("无效批次整体回滚：撤销不存在的通告不留任何痕迹", async () => {
    const counts = async () => {
      const b = await db.pool.query("SELECT count(*)::int AS c FROM notice_batches");
      const n = await db.pool.query("SELECT count(*)::int AS c FROM notices");
      return [b.rows[0].c, n.rows[0].c] as const;
    };
    const before = await counts();
    await assert.rejects(
      db.publishBatch(batch("B-bad", [rev("N-GHOST")])),
      /violates foreign key/,
    );
    const after = await counts();
    assert.deepEqual(after, before);
  });
});

describe("事务失败与幂等", () => {
  beforeEach(truncate);

  test("快照后注入故障：事务回滚、无结果行，重试成功且只产生一份", async () => {
    await db.publishBatch(batch("B-tan", [pub(nTangent)]));
    const req: DecisionRequest = { ...farRoute, decision_id: "D-FAULT", idempotency_key: "key-fault" };

    await assert.rejects(
      db.createDecision(req, { fault: "abort_after_snapshot" }),
      (err: unknown) => err instanceof FaultInjectedError,
    );
    assert.equal(await db.getDecision("D-FAULT"), null);
    const snapRows = await db.pool.query(
      "SELECT count(*)::int AS c FROM decision_snapshot WHERE decision_id='D-FAULT'",
    );
    assert.equal(snapRows.rows[0].c, 0);

    const retry = await db.createDecision(req);
    assert.equal(retry.reused, false);
    assert.equal(retry.result.status, "clear");

    const duplicate = await db.createDecision(req);
    assert.equal(duplicate.reused, true);
    assert.deepEqual(duplicate.result, retry.result);

    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS c FROM decisions WHERE decision_id='D-FAULT'",
    );
    assert.equal(rows[0].c, 1, "重复提交不得产生两份结果");
  });

  test("相同 idempotency_key 携带不同请求内容 => 409", async () => {
    await db.publishBatch(batch("B-tan", [pub(nTangent)]));
    const req1: DecisionRequest = { ...farRoute, decision_id: "D-IDEM-1", idempotency_key: "same-key" };
    const req2: DecisionRequest = { ...tangentRoute, decision_id: "D-IDEM-2", idempotency_key: "same-key" };
    await db.createDecision(req1);
    await assert.rejects(db.createDecision(req2), /已用于另一份请求内容/);
  });

  test("同一 idempotency_key 并发提交只落一行，两个调用方拿到同一结果", async () => {
    await db.publishBatch(batch("B-tan", [pub(nTangent)]));
    const req: DecisionRequest = { ...farRoute, decision_id: "D-RACE", idempotency_key: "race-key" };
    const [a, b2] = await Promise.all([
      db.createDecision(req),
      db.createDecision(req),
    ]);
    assert.equal(a.reused === b2.reused, false, "恰有一方为首次写入");
    assert.deepEqual(a.result, b2.result);
    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS c FROM decisions WHERE idempotency_key='race-key'",
    );
    assert.equal(rows[0].c, 1);
  });
});

describe("重启恢复", () => {
  test("服务进程重启 + 数据库重启后按判定 ID 复现，且冻结快照重放一致", async () => {
    const dataDir = join(tmpdir(), `seazone-restart-${process.pid}-${counter}`);
    const port1 = 56500 + Math.floor(Math.random() * 400);
    const port2 = port1 + 1;
    let pg1: PgInstance | null = null;
    let db1: Db | null = null;
    let pg2: PgInstance | null = null;
    let db2: Db | null = null;
    try {
      pg1 = await startPersistentPg(dataDir, port1);
      db1 = new Db({ connectionString: pg1.cs });
      await db1.migrate();
      await db1.publishBatch(batch("B-v1", [pub(n10())]));
      const created = await db1.createDecision({
        ...fixtureRoute, decision_id: "D-RESTART", idempotency_key: "key-restart",
      });
      await db1.close();
      await pg1.stop();

      // —— 数据库进程重启 ——
      pg2 = await restartPersistentPg(dataDir, port2);
      db2 = new Db({ connectionString: pg2.cs });
      const fetched = await db2.getDecision("D-RESTART");
      assert.ok(fetched, "重启后必须能按 decision_id 取回结论");
      assert.equal(fetched!.status, "restricted");
      assert.deepEqual(fetched, created.result, "取回内容与首次结论逐字节一致");

      // 用冻结的通告集合重放引擎，结果仍一致——即使此后发布更正，
      // 历史判定使用的通告集合也不受影响。
      await db2.publishBatch(batch("B-v2", [pub(n10r2())]));
      const replayed = await db2.replayDecision("D-RESTART");
      assert.deepEqual(replayed, created.result, "冻结快照重放必须复现原结论");
    } finally {
      if (db1) await db1.close().catch(() => {});
      if (pg1) await pg1.stop().catch(() => {});
      if (db2) await db2.close().catch(() => {});
      if (pg2) await pg2.stop().catch(() => {});
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("HTTP 服务进程被杀死后重启，接口仍返回原判定", async () => {
    const httpPort = 57000 + Math.floor(Math.random() * 400);
    const baseUrl = `http://127.0.0.1:${httpPort}`;

    const startServer = () => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", join(root, "src", "server.ts")],
        {
          env: { ...process.env, DATABASE_URL: pg.cs, PORT: String(httpPort) },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.on("data", (d) => {
        const msg = String(d);
        if (msg.includes("请求处理失败") || msg.includes("启动失败")) {
          throw new Error(`服务输出异常: ${msg}`);
        }
      });
      return child;
    };

    const waitReady = async () => {
      for (let i = 0; i < 50; i++) {
        try {
          const res = await fetch(`${baseUrl}/healthz`);
          if (res.ok) return;
        } catch { /* 未就绪 */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("服务未在限定时间内就绪");
    };

    await truncate();
    await db.publishBatch(batch("B-v1", [pub(n10())]));

    // 第一次进程：写入判定。
    const child1 = startServer();
    await waitReady();
    const post = await fetch(`${baseUrl}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...fixtureRoute, decision_id: "D-HTTP-RESTART", idempotency_key: "key-http-restart",
      }),
    });
    assert.equal(post.status, 201);
    const firstBody = await post.json();
    child1.kill("SIGKILL");
    await once(child1, "exit");

    // 第二次进程：只读取，不重新提交，必须复现。
    const child2 = startServer();
    await waitReady();
    const get = await fetch(`${baseUrl}/decisions/D-HTTP-RESTART`);
    assert.equal(get.status, 200);
    const secondBody = await get.json();
    assert.deepEqual(secondBody, firstBody);

    // 幂等：重启后重复提交返回同一结果（200 reused）。
    const repost = await fetch(`${baseUrl}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...fixtureRoute, decision_id: "D-HTTP-RESTART", idempotency_key: "key-http-restart",
      }),
    });
    assert.equal(repost.status, 200);
    child2.kill("SIGTERM");
    await once(child2, "exit");
  });
});

describe("HTTP 契约", () => {
  let baseUrl: string;
  let server: ReturnType<typeof createApp>;

  before(async () => {
    const port = 57500 + Math.floor(Math.random() * 400);
    baseUrl = `http://127.0.0.1:${port}`;
    server = createApp({ db });
    await new Promise<void>((resolve) => server.listen(port, resolve));
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(truncate);

  test("健康检查 / 非法请求 400 / 正常判定 201", async () => {
    const h = await fetch(`${baseUrl}/healthz`);
    assert.equal(h.status, 200);

    const bad = await fetch(`${baseUrl}/decisions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision_id: "x" }),
    });
    assert.equal(bad.status, 400);

    await db.publishBatch(batch("B-v1", [pub(n10())]));
    const ok = await fetch(`${baseUrl}/decisions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(fixtureRoute),
    });
    assert.equal(ok.status, 201);
    const body = (await ok.json()) as { status: string; first_intersection: { segment_index: number } };
    assert.equal(body.status, "restricted");
    assert.equal(body.first_intersection.segment_index, 0);

    const missing = await fetch(`${baseUrl}/decisions/NOPE`);
    assert.equal(missing.status, 404);
  });

  test("非法批次 400、重复批次 409、撤销不存在通告 400（事务整体失败）", async () => {
    const badShape = await fetch(`${baseUrl}/admin/batches`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ batch_ref: "", ops: [] }),
    });
    assert.equal(badShape.status, 400);

    const unclosed = await fetch(`${baseUrl}/admin/batches`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batch_ref: "B-unclosed",
        ops: [{ op: "publish", notice: {
          notice_id: "N-X", issuer: "AUTH", sequence: 1, revision: 1, replaces: null,
          valid_from: "2026-09-10T00:00:00+08:00", valid_until: "2026-09-11T00:00:00+08:00",
          polygon: [[121, 30], [121.2, 30], [121.2, 30.2], [121, 30.2]],
        } }],
      }),
    });
    assert.equal(unclosed.status, 400);
    assert.ok(((await unclosed.json()) as { error: string }).error.includes("闭合"));

    const good = {
      batch_ref: "B-dup",
      ops: [{ op: "publish", notice: {
        notice_id: "N-D", issuer: "AUTH", sequence: 1, revision: 1, replaces: null,
        valid_from: "2026-09-10T00:00:00+08:00", valid_until: "2026-09-11T00:00:00+08:00",
        polygon: [[121, 30], [121.2, 30], [121.2, 30.2], [121, 30.2], [121, 30]],
      } }],
    };
    const first = await fetch(`${baseUrl}/admin/batches`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good),
    });
    assert.equal(first.status, 201);
    const dup = await fetch(`${baseUrl}/admin/batches`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good),
    });
    assert.equal(dup.status, 409);

    const ghost = await fetch(`${baseUrl}/admin/batches`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ batch_ref: "B-ghost", ops: [{ op: "revoke", notice_id: "N-GHOST" }] }),
    });
    assert.equal(ghost.status, 400);
    // 失败批次不留批次行。
    const { rows } = await db.pool.query("SELECT count(*)::int c FROM notice_batches WHERE batch_ref='B-ghost'");
    assert.equal(rows[0].c, 0);
  });

  test("recheck 端点在依据撤销后返回 stale", async () => {
    await db.publishBatch(batch("B-v1", [pub(n10())]));
    await fetch(`${baseUrl}/decisions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(fixtureRoute),
    });
    await db.publishBatch(batch("B-revoke", [rev("N-10")]));
    const res = await fetch(`${baseUrl}/decisions/D-01/recheck`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { stale: boolean; result: { status: string } };
    assert.equal(body.stale, true);
    assert.equal(body.result.status, "stale");
  });
});
