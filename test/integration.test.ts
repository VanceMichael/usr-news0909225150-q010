import { test, before } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import {
  armGate,
  releaseGate,
  migrate,
  publishNotice,
  createDecision,
  getDecision,
  requestHash,
  ConflictError,
} from "../src/service/decision.service.js";
import { evaluate } from "../src/domain/evaluate.js";
import { ValidationError, type NoticeInput } from "../src/domain/validation.js";
import {
  getDecisionById,
  getSnapshotLinks,
} from "../src/db/decisions.repo.js";
import type { NoticeRecord, RouteRequest } from "../src/domain/types.js";

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0],
];

let seq = 0;
const nextSeq = (): number => ++seq;

function noticeInput(over: Partial<NoticeInput> & Pick<NoticeInput, "noticeId" | "revision" | "replaces" | "validFrom" | "validUntil" | "polygon">): NoticeInput {
  return {
    issuer: "AUTH-T",
    sequence: nextSeq(),
    status: "active",
    ...over,
  };
}

function routeRequest(over: Partial<RouteRequest> & Pick<RouteRequest, "decisionId" | "departureAt" | "route">): RouteRequest {
  return {
    idempotencyKey: `idem-${over.decisionId}`,
    speedKnots: 30,
    ...over,
  };
}

async function resetDb(): Promise<void> {
  await pool.query(
    "truncate decisions, decision_snapshot_notices, notices, test_gates restart identity cascade",
  );
}

before(async () => {
  await migrate();
});

test("跨午夜有效期：进入时刻在当日、离开时刻在次日", async () => {
  await resetDb();
  await publishNotice(noticeInput({
    noticeId: "N-MID",
    revision: 1, replaces: null,
    validFrom: "2026-09-20T20:00:00Z",
    validUntil: "2026-09-21T02:00:00Z",
    polygon: rect(0.7, -0.1, 1.3, 0.1),
  }));
  const req = routeRequest({
    decisionId: "D-MID",
    departureAt: "2026-09-20T22:00:00Z",
    route: [[0, 0], [2, 0]],
  });
  const { inserted, stored } = await createDecision(req);
  assert.equal(inserted, true);
  assert.equal(stored.result.status, "restricted");
  const hit = stored.result.firstIntersection!;
  assert.equal(hit.noticeId, "N-MID");
  assert.match(hit.enterAt, /^2026-09-20T23:2/);
  assert.match(hit.exitAt, /^2026-09-21T00:3/);
  assert.equal(hit.relation, "interior");
  assert.equal(hit.onBoundaryOnly, false);

  // 航程整体在有效期之后（左闭右开，valid_until 时刻已失效）=> clear。
  const after = routeRequest({
    decisionId: "D-AFTER",
    departureAt: "2026-09-21T02:00:00Z",
    route: [[0, 0], [2, 0]],
  });
  assert.equal((await createDecision(after)).stored.result.status, "clear");
});

test("撤销更正：撤销版自 valid_from 终止前版，旧判定复算变 stale，新判定 clear", async () => {
  await resetDb();
  await publishNotice(noticeInput({
    noticeId: "N-V1",
    revision: 1, replaces: null,
    validFrom: "2026-09-20T00:00:00Z",
    validUntil: "2026-09-22T00:00:00Z",
    polygon: rect(0.7, -0.1, 1.3, 0.1),
  }));
  const req = routeRequest({
    decisionId: "D-REVOKE",
    departureAt: "2026-09-20T20:00:00Z",
    route: [[0, 0], [2, 0]],
  });
  const before = await createDecision(req);
  assert.equal(before.stored.result.status, "restricted");

  // 发布撤销更正（revision 2，status=revoked）。
  await publishNotice(noticeInput({
    noticeId: "N-V2-CANCEL",
    revision: 2, replaces: "N-V1", status: "revoked",
    validFrom: "2026-09-20T18:00:00Z",
    validUntil: "2026-09-22T00:00:00Z",
    polygon: rect(0.7, -0.1, 1.3, 0.1),
  }));

  const view = await getDecision("D-REVOKE");
  assert.equal(view!.basisCurrent, false);
  assert.equal(view!.decision.status, "stale");
  assert.equal(view!.reassessment!.storedStatus, "restricted");
  assert.equal(view!.reassessment!.reassessedStatus, "clear");

  // 用同一计划重新判定：撤销时刻之后无生效版本 => clear，
  // 依据中保留撤销版本，status 标明 revoked，供值班员复核“更正是否替代原通告”。
  const fresh = await createDecision(routeRequest({
    decisionId: "D-REVOKE-2",
    departureAt: "2026-09-20T20:00:00Z",
    route: [[0, 0], [2, 0]],
  }));
  assert.equal(fresh.stored.result.status, "clear");
  const basis = fresh.stored.result.effectiveNotices;
  assert.deepEqual(basis.map((b) => b.noticeId), ["N-V2-CANCEL"]);
  assert.equal(basis[0]!.status, "revoked");
});

test("边界相切：顶点接触与沿边滑行均判 needs_review，穿越判 restricted", async () => {
  await resetDb();
  await publishNotice(noticeInput({
    noticeId: "N-TAN",
    revision: 1, replaces: null,
    validFrom: "2026-09-01T00:00:00Z",
    validUntil: "2026-12-31T00:00:00Z",
    polygon: rect(0.5, 0.5, 1.5, 1.5),
  }));

  // 顶点相切（直线 y=-x 仅触及顶点 (0.5,0.5)）。
  const vertex = await createDecision(routeRequest({
    decisionId: "D-VERTEX",
    departureAt: "2026-09-20T00:00:00Z",
    route: [[-2 + 0.5, 2 + 0.5], [2 + 0.5, -2 + 0.5]],
  }));
  assert.equal(vertex.stored.result.status, "needs_review");
  assert.match(vertex.stored.result.reviewReasons[0]!, /边界相切/);

  // 沿边滑行。
  const edge = await createDecision(routeRequest({
    decisionId: "D-EDGE",
    departureAt: "2026-09-20T00:00:00Z",
    route: [[0.6, 0.5], [1.4, 0.5]],
  }));
  assert.equal(edge.stored.result.status, "needs_review");

  // 穿越 => restricted。
  const cross = await createDecision(routeRequest({
    decisionId: "D-CROSS",
    departureAt: "2026-09-20T00:00:00Z",
    route: [[0, 1.0], [2, 1.0]],
  }));
  assert.equal(cross.stored.result.status, "restricted");
});

test("幂等：重复提交（含并发）只产生一份结果", async () => {
  await resetDb();
  await publishNotice(noticeInput({
    noticeId: "N-IDEM",
    revision: 1, replaces: null,
    validFrom: "2026-09-01T00:00:00Z",
    validUntil: "2026-12-31T00:00:00Z",
    polygon: rect(0, 0, 10, 10),
  }));
  const req = routeRequest({
    decisionId: "D-IDEM",
    idempotencyKey: "same-key",
    departureAt: "2026-09-20T00:00:00Z",
    route: [[1, 1], [2, 2]],
  });
  const first = await createDecision(req);
  const second = await createDecision(req);
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.deepEqual(second.stored.result, first.stored.result);

  // 并发双提交：恰好一份 inserted，总数 1。
  const req2 = routeRequest({
    decisionId: "D-IDEM-2", idempotencyKey: "same-key-2",
    departureAt: "2026-09-20T00:00:00Z",
    route: [[1, 1], [2, 2]],
  });
  const results = await Promise.all([createDecision(req2), createDecision(req2)]);
  assert.equal(results.filter((r) => r.inserted).length, 1);
  const { rows } = await pool.query("select count(*)::int as c from decisions where decision_id = $1", ["D-IDEM-2"]);
  assert.equal(rows[0].c, 1);
});

test("冲突：idempotency_key 复用于不同判定 => 409", async () => {
  await resetDb();
  const req1 = routeRequest({
    decisionId: "D-C1", idempotencyKey: "shared",
    departureAt: "2026-09-20T00:00:00Z",
    route: [[1, 1], [2, 2]],
  });
  const req2 = routeRequest({
    decisionId: "D-C2", idempotencyKey: "shared",
    departureAt: "2026-09-20T00:00:00Z",
    route: [[1, 1], [2, 2]],
  });
  await createDecision(req1);
  await assert.rejects(() => createDecision(req2), ConflictError);
});

test("并发发布：判定进行中发布的通告不得混入该次快照（确定性门闩交错）", async () => {
  await resetDb();
  await publishNotice(noticeInput({
    noticeId: "N-OLD",
    revision: 1, replaces: null,
    validFrom: "2026-09-01T00:00:00Z",
    validUntil: "2026-12-31T00:00:00Z",
    polygon: rect(5, 5, 6, 6), // 与航线无关
  }));
  await armGate("decision_before_snapshot", {});

  const req = routeRequest({
    decisionId: "D-RACE",
    departureAt: "2026-09-20T00:00:00Z",
    route: [[0, 0], [2, 0]],
  });
  const decisionPromise = createDecision(req);
  // 等待判定事务到达门闩（已持目录锁）。
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query<{ arrivals: number }>(
      "select arrivals from test_gates where gate_id = 'decision_before_snapshot'",
    );
    if (rows[0]?.arrivals === 1) break;
    await new Promise((r) => setTimeout(r, 30));
  }

  // 并发发布与航线相交的新通告：必须阻塞在目录锁外。
  const publishPromise = publishNotice(noticeInput({
    noticeId: "N-NEW",
    revision: 1, replaces: null,
    validFrom: "2026-09-01T00:00:00Z",
    validUntil: "2026-12-31T00:00:00Z",
    polygon: rect(0.7, -0.1, 1.3, 0.1),
  }));
  await new Promise((r) => setTimeout(r, 300));

  assert.equal((await pool.query("select count(*)::int c from notices where notice_id='N-NEW'")).rows[0].c, 0);

  await releaseGate("decision_before_snapshot");
  const decision = await decisionPromise;
  const published = await publishPromise;
  assert.equal(published.noticeId, "N-NEW");

  // 判定快照是发布前缀：只含 N-OLD，不含判定期间正在提交的 N-NEW。
  assert.deepEqual(decision.stored.result.snapshotNoticeIds, ["N-OLD"]);
  assert.equal(decision.stored.result.status, "clear");

  // 新通告发布后再读旧判定：依据变化 => stale，复算为 restricted。
  const view = await getDecision("D-RACE");
  assert.equal(view!.basisCurrent, false);
  assert.equal(view!.decision.status, "stale");
  assert.equal(view!.reassessment!.reassessedStatus, "restricted");

  await pool.query("delete from test_gates");
});

test("并发重复发布同一机构序列：恰好一份成功，另一份 409", async () => {
  await resetDb();
  const input: NoticeInput = {
    noticeId: "N-DUP",
    issuer: "AUTH-T",
    sequence: 5001,
    revision: 1,
    replaces: null,
    validFrom: "2026-09-01T00:00:00Z",
    validUntil: "2026-12-31T00:00:00Z",
    polygon: rect(0, 0, 1, 1),
    status: "active",
  };
  const outcomes = await Promise.allSettled([publishNotice(input), publishNotice(input)]);
  const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
  const rejected = outcomes.filter((o) => o.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ConflictError);
  const { rows } = await pool.query("select count(*)::int c from notices where issuer='AUTH-T' and sequence=5001");
  assert.equal(rows[0].c, 1);
});

test("事务失败：插入前回滚不留任何痕迹，清理门闩后同请求可成功", async () => {
  await resetDb();
  await publishNotice(noticeInput({
    noticeId: "N-FAIL",
    revision: 1, replaces: null,
    validFrom: "2026-09-01T00:00:00Z",
    validUntil: "2026-12-31T00:00:00Z",
    polygon: rect(0, 0, 10, 10),
  }));
  await armGate("decision_before_insert", { fail: true });
  const req = routeRequest({
    decisionId: "D-FAIL",
    departureAt: "2026-09-20T00:00:00Z",
    route: [[20, 20], [22, 22]],
  });
  await assert.rejects(() => createDecision(req), /门闩/);

  const { rows: dRows } = await pool.query("select count(*)::int c from decisions where decision_id='D-FAIL'");
  assert.equal(dRows[0].c, 0);
  const { rows: lRows } = await pool.query("select count(*)::int c from decision_snapshot_notices where decision_id='D-FAIL'");
  assert.equal(lRows[0].c, 0);

  await pool.query("delete from test_gates");
  const retry = await createDecision(req);
  assert.equal(retry.inserted, true);
  assert.equal(retry.stored.result.status, "clear");
});

test("非法更正（revision 不接续）：拒绝发布且库内无新增", async () => {
  await resetDb();
  await publishNotice(noticeInput({
    noticeId: "N-BASE",
    revision: 1, replaces: null,
    validFrom: "2026-09-01T00:00:00Z",
    validUntil: "2026-12-31T00:00:00Z",
    polygon: rect(0, 0, 1, 1),
  }));
  const bad = noticeInput({
    noticeId: "N-BAD",
    revision: 3, replaces: "N-BASE",
    validFrom: "2026-09-02T00:00:00Z",
    validUntil: "2026-12-31T00:00:00Z",
    polygon: rect(0, 0, 1, 1),
  });
  await assert.rejects(() => publishNotice(bad), ValidationError);
  const { rows } = await pool.query("select count(*)::int c from notices");
  assert.equal(rows[0].c, 1);
});

test("重启恢复：仅凭判定 ID 与行内冻结快照即可复现当时结论与通告集合", async () => {
  await resetDb();
  await publishNotice(noticeInput({
    noticeId: "N-PERSIST",
    revision: 1, replaces: null,
    validFrom: "2026-09-01T00:00:00Z",
    validUntil: "2026-12-31T00:00:00Z",
    polygon: rect(0.7, -0.1, 1.3, 0.1),
  }));
  const req = routeRequest({
    decisionId: "D-PERSIST",
    departureAt: "2026-09-20T00:00:00Z",
    route: [[0, 0], [2, 0]],
  });
  await createDecision(req);

  // 模拟服务重启后的新进程：直接从库中取行，用行内冻结的通告集合重新纯函数计算。
  const client = await pool.connect();
  try {
    const stored = await getDecisionById(client, "D-PERSIST");
    assert.ok(stored);
    const reproduced = evaluate({
      request: stored!.request,
      snapshotNotices: stored!.result.snapshotNotices,
      snapshotMaxPublishOrder: stored!.snapshotMaxPublishOrder,
      evaluatedAt: stored!.result.evaluatedAt,
    });
    assert.deepEqual(reproduced, stored!.result);

    const links = await getSnapshotLinks(client, "D-PERSIST");
    assert.deepEqual(links.map((l) => l.noticeId), stored!.result.snapshotNoticeIds);
    assert.equal(requestHash(stored!.request), stored!.requestHash);
  } finally {
    client.release();
  }
});
