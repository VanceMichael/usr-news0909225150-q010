import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";
import {
  getMaxPublishOrder,
  getNoticeById,
  getSnapshotNotices,
  getAllNotices,
  insertNotice,
  type NewNotice,
} from "../db/notices.repo.js";
import {
  getDecisionById,
  getDecisionByIdempotencyKey,
  insertDecision,
  insertSnapshotLinks,
  markStaleWithReassessment,
  type StoredDecision,
} from "../db/decisions.repo.js";
import { evaluate, canonicalRequestJson } from "../domain/evaluate.js";
import { assertRevisionLink, type NoticeInput } from "../domain/validation.js";
import type {
  DecisionResult,
  NoticeRecord,
  Reassessment,
  RouteRequest,
} from "../domain/types.js";

/**
 * 通告目录串行锁：发布与判定均先取会话级排他咨询锁，再开启事务。
 * 这样 REPEATABLE READ 快照在“无并发发布”的时刻建立，读到的必为发布全序的某个前缀，
 * 杜绝判定事务跨越并发发布而使用混合版本。
 */
const CATALOG_LOCK_KEY = 9_876_543_210;

export class ConflictError extends Error {
  status = 409;
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

class GateAbortError extends Error {
  status = 500;
  constructor(gateId: string) {
    super(`测试门闩 ${gateId} 触发事务中止`);
    this.name = "GateAbortError";
  }
}

export function requestHash(request: RouteRequest): string {
  return createHash("sha256").update(canonicalRequestJson(request)).digest("hex");
}

/**
 * 仅供验收测试的确定性事务门闩：test_gates 中无对应行时为空操作。
 * 到达信号通过独立 autocommit 连接写入（对等待方立即可见）；
 * released=false 时持事务等待；fail=true 时抛错回滚。
 */
async function checkpoint(client: PoolClient, gateId: string): Promise<void> {
  const { rowCount } = await pool.query(
    "update test_gates set arrivals = arrivals + 1 where gate_id = $1",
    [gateId],
  );
  if (rowCount === 0) return;
  const { rows: cfg } = await pool.query<{ fail: boolean }>(
    "select fail from test_gates where gate_id = $1",
    [gateId],
  );
  if (cfg[0]!.fail) throw new GateAbortError(gateId);
  const deadline = Date.now() + 15_000;
  for (;;) {
    // 门闩状态必须走事务外的 autocommit 连接读取，否则 RR 快照看不到释放更新。
    const { rows } = await pool.query<{ released: boolean }>(
      "select released from test_gates where gate_id = $1",
      [gateId],
    );
    if (rows[0]!.released) return;
    if (Date.now() > deadline) throw new Error(`门闩 ${gateId} 等待超时`);
    await pool.query("select pg_sleep(0.02)");
  }
}

/** 测试辅助：设置门闩。 */
export async function armGate(
  gateId: string,
  opts: { release?: boolean; fail?: boolean },
): Promise<void> {
  await pool.query(
    `insert into test_gates (gate_id, released, fail) values ($1, $2, $3)
     on conflict (gate_id) do update set released = $2, fail = $3, arrivals = 0`,
    [gateId, opts.release ?? false, opts.fail ?? false],
  );
}

export async function gateArrivals(gateId: string): Promise<number> {
  const { rows } = await pool.query<{ arrivals: number }>(
    "select arrivals from test_gates where gate_id = $1",
    [gateId],
  );
  return rows[0]?.arrivals ?? 0;
}

export async function releaseGate(gateId: string): Promise<void> {
  await pool.query("update test_gates set released = true where gate_id = $1", [gateId]);
}

async function withCatalogLock<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  await client.query("select pg_advisory_lock($1)", [CATALOG_LOCK_KEY]);
  try {
    return await fn(client);
  } finally {
    await client.query("select pg_advisory_unlock($1)", [CATALOG_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/** 发布一份通告版本（append-only），在目录锁下校验版本链接续关系。 */
export async function publishNotice(input: NoticeInput): Promise<NoticeRecord> {
  return withCatalogLock(async (client) => {
    await client.query("begin");
    try {
      await checkpoint(client, "publish_before_insert");
      const parent = input.replaces === null ? null : await getNoticeById(client, input.replaces);
      assertRevisionLink(parent, input);
      const row: NewNotice = {
        noticeId: input.noticeId,
        issuer: input.issuer,
        sequence: input.sequence,
        revision: input.revision,
        replaces: input.replaces,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        polygon: input.polygon,
        status: input.status,
      };
      const published = await insertNotice(client, row);
      await client.query("commit");
      return published;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictError("notice_id 或 (issuer, sequence) 已存在，禁止覆盖发布");
      }
      throw err;
    }
  });
}

export interface DecisionOutcome {
  stored: StoredDecision;
  inserted: boolean;
}

/** 锁后在新事务中读取既有判定（唯一冲突后的处置路径）。 */
async function fetchExisting(
  client: PoolClient,
  request: RouteRequest,
  hash: string,
): Promise<DecisionOutcome> {
  await client.query("begin isolation level repeatable read");
  try {
    const stored =
      (await getDecisionById(client, request.decisionId)) ??
      (await getDecisionByIdempotencyKey(client, request.idempotencyKey));
    await client.query("commit");
    if (!stored) throw new ConflictError("提交冲突且查不到既有判定，请重试");
    if (stored.requestHash !== hash) {
      throw new ConflictError(`idempotency_key/decision_id 已绑定内容不同的请求`);
    }
    return { stored, inserted: false };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

/**
 * 提交一次判定：
 * - 先取目录排他锁，再开 REPEATABLE READ 事务 → 快照必为发布前缀（无混合版本）；
 * - decision_id / idempotency_key 唯一约束 + 锁内查重，重复提交只返回既有一份结果；
 * - 任何失败整体回滚，绝不留下半份判定。
 */
export async function createDecision(request: RouteRequest): Promise<DecisionOutcome> {
  const hash = requestHash(request);
  return withCatalogLock(async (client) => {
    await client.query("begin isolation level repeatable read");
    try {
      const existing = await getDecisionById(client, request.decisionId);
      if (existing) {
        if (existing.requestHash !== hash) {
          throw new ConflictError(`decision_id ${request.decisionId} 已用于不同请求`);
        }
        await client.query("commit");
        return { stored: existing, inserted: false };
      }
      const existingKey = await getDecisionByIdempotencyKey(client, request.idempotencyKey);
      if (existingKey) {
        throw new ConflictError(
          `idempotency_key ${request.idempotencyKey} 已绑定判定 ${existingKey.decisionId}`,
        );
      }

      await checkpoint(client, "decision_before_snapshot");
      const highWater = await getMaxPublishOrder(client);
      const notices = highWater === null ? [] : await getSnapshotNotices(client, highWater);

      const result: DecisionResult = evaluate({
        request,
        snapshotNotices: notices,
        snapshotMaxPublishOrder: highWater,
        evaluatedAt: new Date().toISOString(),
      });

      await checkpoint(client, "decision_before_insert");
      const insertedRow = await insertDecision(client, { request, requestHash: hash, result });
      await insertSnapshotLinks(
        client,
        request.decisionId,
        notices.map((n) => ({ noticeId: n.noticeId, publishOrder: n.publishOrder })),
      );
      await client.query("commit");
      return { stored: insertedRow, inserted: true };
    } catch (err) {
      await client.query("rollback").catch(() => {});
      if ((err as { code?: string }).code === "23505") {
        // 理论上锁内查重已覆盖；防御性地回读既有结论。
        return fetchExisting(client, request, hash);
      }
      throw err;
    }
  });
}

export interface DecisionView {
  decision: DecisionResult;
  basisCurrent: boolean;
  reassessment: Reassessment | null;
}

function sameIntersection(
  a: DecisionResult["firstIntersection"],
  b: DecisionResult["firstIntersection"],
): boolean {
  if (a === null || b === null) return a === b;
  return a.noticeId === b.noticeId && a.segmentIndex === b.segmentIndex && a.enterAt === b.enterAt;
}

/**
 * 读取判定并核对依据是否仍为当前版本：
 * - 快照高水位 == 当前高水位：依据有效；
 * - 否则用当前通告全量重算；状态/首个相交/依据集合均不变则仍 basis_current；
 * - 有变化则把原判定置为 stale 并附复算结论；冻结的原始结果保留在 reassessment 中可审计。
 */
export async function getDecision(decisionId: string): Promise<DecisionView | null> {
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read");
    let stored = await getDecisionById(client, decisionId);
    if (!stored) {
      await client.query("rollback");
      return null;
    }

    const currentMax = await getMaxPublishOrder(client);
    if (stored.snapshotMaxPublishOrder === currentMax) {
      const current = stored.status;
      await client.query("commit");
      return {
        decision: { ...stored.result, status: current },
        basisCurrent: current !== "stale",
        reassessment: stored.reassessment,
      };
    }

    const currentNotices = await getAllNotices(client);
    const reassessed: DecisionResult = evaluate({
      request: stored.request,
      snapshotNotices: currentNotices,
      snapshotMaxPublishOrder: currentMax,
      evaluatedAt: new Date().toISOString(),
    });

    const basisUnchanged =
      reassessed.status === stored.result.status &&
      sameIntersection(reassessed.firstIntersection, stored.result.firstIntersection) &&
      JSON.stringify(reassessed.effectiveNotices.map((n) => n.noticeId)) ===
        JSON.stringify(stored.result.effectiveNotices.map((n) => n.noticeId));

    if (basisUnchanged && stored.status !== "stale") {
      await client.query("commit");
      return { decision: stored.result, basisCurrent: true, reassessment: null };
    }

    const reassessment: Reassessment = basisUnchanged && stored.reassessment
      ? stored.reassessment
      : {
          decisionId,
          basisCurrent: false,
          storedStatus: stored.result.status,
          reassessedStatus: reassessed.status,
          reassessed,
        };
    const updated = await markStaleWithReassessment(client, decisionId, reassessment);
    await client.query("commit");
    stored = updated ?? stored;
    return {
      decision: { ...stored.result, status: "stale" },
      basisCurrent: false,
      reassessment,
    };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** 启动时迁移；供 server 与测试调用。 */
export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await runMigrations(client);
  } finally {
    client.release();
  }
}
