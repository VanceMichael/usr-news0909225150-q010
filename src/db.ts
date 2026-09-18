/**
 * 数据库层：迁移、通告批次发布、判定事务、复现与复检。
 *
 * 一致性快照的实现：
 *  1. 发布与判定都在事务内先取同一把事务级咨询锁
 *     (ADVISORY_LOCK_NS, 0)，使"发布批次"与"判定"在全局完全有序，
 *     判定进行中不可能穿插提交新批次；
 *  2. 一个批次的全部 INSERT 在同一事务内提交，其他事务要么看到
 *     整批、要么完全看不到——并发更新不可能产生混合版本；
 *  3. 判定行与其快照明细（decision_snapshot）在同一事务写入，
 *     任何中途失败整体回滚，不留半成品。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type {
  BatchInput,
  DecisionRequest,
  DecisionResult,
  EffectiveNotice,
  NoticeBasis,
} from "./types.js";

const { Pool } = pg;

/** 咨询锁命名空间（固定常量，发布/判定共用同一把锁）。 */
const ADVISORY_LOCK_KEY = 900101;

export interface DbConfig {
  connectionString?: string;
}

export class Db {
  readonly pool: pg.Pool;

  constructor(config: DbConfig = {}) {
    this.pool = new Pool({
      connectionString: config.connectionString ?? process.env.DATABASE_URL,
      max: 10,
    });
    this.pool.on("error", (err) => {
      console.error("空闲数据库连接错误:", err);
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async migrate(): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    // 开发（tsx：src/…）与生产（dist/…）两种布局都兼容。
    const candidates = [
      join(here, "migrations", "001_init.sql"),
      join(here, "..", "migrations", "001_init.sql"),
      join(here, "..", "src", "migrations", "001_init.sql"),
    ];
    let sql: string | null = null;
    for (const path of candidates) {
      try {
        sql = readFileSync(path, "utf8");
        break;
      } catch { /* try next */ }
    }
    if (!sql) throw new Error("找不到迁移文件 001_init.sql");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations(version) VALUES ('001_init')
         ON CONFLICT DO NOTHING`,
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** 原子发布一个批次（发布 + 撤销可混合，全部成功或全部不生效）。 */
  async publishBatch(batch: BatchInput): Promise<{ batchId: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]);

        const batchRes = await client.query(
          `INSERT INTO notice_batches (batch_ref) VALUES ($1)
           RETURNING id`,
          [batch.batch_ref],
        );
        const batchId = batchRes.rows[0].id as number;

        for (const op of batch.ops) {
          if (op.op === "revoke") {
            await client.query(
              `INSERT INTO notice_revocations (notice_id, batch_id)
               VALUES ($1, $2)`,
              [op.notice_id, batchId],
            );
            continue;
          }
          const n = op.notice;
          await client.query(
            `INSERT INTO notices
               (notice_id, issuer, sequence, revision, replaces,
                valid_from, valid_until, polygon, batch_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
            [
              n.notice_id, n.issuer, n.sequence, n.revision, n.replaces,
              n.valid_from, n.valid_until, JSON.stringify(n.polygon), batchId,
            ],
          );
        }
        await client.query("COMMIT");
        return { batchId };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    } finally {
      client.release();
    }
  }

  /** 读取当前全部通告及其撤销状态（复检时使用）。 */
  private async currentNotices(client: pg.PoolClient): Promise<EffectiveNotice[]> {
    const res = await client.query(
      `SELECT n.notice_id, n.issuer, n.sequence, n.revision, n.replaces,
              n.valid_from, n.valid_until, n.polygon, n.batch_id,
              CASE WHEN r.notice_id IS NULL THEN 'active' ELSE 'revoked' END AS status
       FROM notices n
       LEFT JOIN notice_revocations r ON r.notice_id = n.notice_id
       ORDER BY n.issuer, n.sequence`,
    );
    return res.rows.map(rowToNotice);
  }

  /**
   * 幂等判定。重复提交（相同 idempotency_key）返回首次结果，
   * 不会产生第二行；相同 decision_id 也返回原结果。
   *
   * fault=abort_after_snapshot 时在读快照后故意回滚，用于验证
   * 事务失败不留任何痕迹且可安全重试。
   */
  async createDecision(
    request: DecisionRequest,
    opts: { fault?: "abort_after_snapshot" | null } = {},
  ): Promise<{ result: DecisionResult; reused: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        // 与发布通道共用一把锁：判定开始后，已提交批次集合即冻结。
        await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]);

        const existing = await client.query(
          `SELECT result, request_hash FROM decisions
           WHERE idempotency_key = $1 OR decision_id = $2`,
          [request.idempotency_key, request.decision_id],
        );
        if (existing.rows.length > 0) {
          const row = existing.rows[0]!;
          if (row.request_hash !== requestHash(request)) {
            throw new ConflictError(
              `idempotency_key=${request.idempotency_key} 已用于另一份请求内容`,
            );
          }
          await client.query("COMMIT");
          return { result: row.result as DecisionResult, reused: true };
        }

        const maxBatchRes = await client.query(
          `SELECT COALESCE(max(id), 0) AS max_id FROM notice_batches`,
        );
        const maxBatch = Number(maxBatchRes.rows[0].max_id);

        const refsRes = await client.query(
          `SELECT batch_ref FROM notice_batches WHERE id <= $1 ORDER BY id`,
          [maxBatch],
        );
        const batchRefs: string[] = refsRes.rows.map((r) => r.batch_ref);
        const notices = await this.currentNotices(client);

        if (opts.fault === "abort_after_snapshot") {
          await client.query("ROLLBACK");
          throw new FaultInjectedError("快照读取后注入故障，事务回滚");
        }

        // 延迟到事务内导入，避免 db ↔ engine 循环加载问题。
        const { evaluate } = await import("./engine.js");
        const result = evaluate({
          request,
          notices,
          snapshotRefs: { batch_refs: batchRefs },
          evaluatedAt: new Date(),
        });

        await client.query(
          `INSERT INTO decisions
             (decision_id, idempotency_key, request_body, request_hash,
              status, result, snapshot_max_batch)
           VALUES ($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7)`,
          [
            request.decision_id,
            request.idempotency_key,
            JSON.stringify(request),
            requestHash(request),
            result.status,
            JSON.stringify(result),
            maxBatch,
          ],
        );
        await client.query(
          `INSERT INTO decision_snapshot (decision_id, notice_id, visible_status)
           SELECT $1, n.notice_id,
                  CASE WHEN r.notice_id IS NULL THEN 'active' ELSE 'revoked' END
           FROM notices n
           LEFT JOIN notice_revocations r ON r.notice_id = n.notice_id`,
          [request.decision_id],
        );

        await client.query("COMMIT");
        return { result, reused: false };
      } catch (err) {
        // FaultInjectedError 已自行回滚；其余异常统一兜底回滚。
        if (!(err instanceof FaultInjectedError)) {
          await client.query("ROLLBACK").catch(() => {});
        }
        throw err;
      }
    } finally {
      client.release();
    }
  }

  /** 按判定 ID 取回冻结结果（重启后仍可复现）。 */
  async getDecision(decisionId: string): Promise<DecisionResult | null> {
    const res = await this.pool.query(
      `SELECT result FROM decisions WHERE decision_id = $1`,
      [decisionId],
    );
    return (res.rows[0]?.result as DecisionResult | undefined) ?? null;
  }

  /**
   * 用 decision_snapshot 冻结的通告集合（含当时 visible_status）与
   * 冻结请求，在任何时刻重放判定引擎。通告几何只追加、不可变，
   * 状态取冻结行而非当前值，因此重放结果与原结果逐字段一致。
   */
  async replayDecision(decisionId: string): Promise<DecisionResult | null> {
    const res = await this.pool.query(
      `SELECT d.request_body, d.result,
              (SELECT jsonb_agg(jsonb_build_object(
                 'notice_id', n.notice_id,
                 'issuer', n.issuer,
                 'sequence', n.sequence,
                 'revision', n.revision,
                 'replaces', n.replaces,
                 'valid_from', to_jsonb(n.valid_from) #>> '{}',
                 'valid_until', to_jsonb(n.valid_until) #>> '{}',
                 'polygon', n.polygon,
                 'status', s.visible_status,
                 'batch_id', n.batch_id))
                 FROM decision_snapshot s
                 JOIN notices n ON n.notice_id = s.notice_id
                WHERE s.decision_id = d.decision_id) AS notices,
              (SELECT jsonb_agg(b.batch_ref ORDER BY b.id)
                 FROM notice_batches b WHERE b.id <= d.snapshot_max_batch) AS batch_refs
       FROM decisions d
       WHERE d.decision_id = $1`,
      [decisionId],
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    const { evaluate } = await import("./engine.js");
    // 通告为 0 份时 jsonb_agg 返回 null。
    const notices = (row.notices ?? []) as EffectiveNotice[];
    // JSONB 中的时间是带偏移文本，统一归一化为 ISO。
    for (const n of notices) {
      n.valid_from = new Date(n.valid_from).toISOString();
      n.valid_until = new Date(n.valid_until).toISOString();
      n.sequence = Number(n.sequence);
      n.revision = Number(n.revision);
      n.batch_id = Number(n.batch_id);
    }
    return evaluate({
      request: row.request_body as DecisionRequest,
      notices,
      snapshotRefs: { batch_refs: row.batch_refs ?? [] },
      evaluatedAt: new Date((row.result as DecisionResult).evaluated_at),
    });
  }

  /**
   * 复检：用冻结的原始请求在当前通告集合上重算，比较结论与依据。
   * 不变更历史行；依据已漂移时返回 status=stale 与差异说明。
   */
  async recheckDecision(
    decisionId: string,
  ): Promise<{ result: DecisionResult; stale: boolean } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]);

        const stored = await client.query(
          `SELECT request_body, result, snapshot_max_batch FROM decisions
           WHERE decision_id = $1`,
          [decisionId],
        );
        if (stored.rows.length === 0) {
          await client.query("COMMIT");
          return null;
        }
        const original = stored.rows[0].result as DecisionResult;
        const request = stored.rows[0].request_body as DecisionRequest;
        const frozenMaxBatch = Number(stored.rows[0].snapshot_max_batch);

        const refsRes = await client.query(
          `SELECT batch_ref, id FROM notice_batches ORDER BY id`,
        );
        const currentRefs = refsRes.rows.map((r) => r.batch_ref as string);
        const notices = await this.currentNotices(client);

        const { evaluate } = await import("./engine.js");
        const fresh = evaluate({
          request,
          notices,
          snapshotRefs: { batch_refs: currentRefs },
          evaluatedAt: new Date(),
        });

        const difference = diffBasis(original, fresh, frozenMaxBatch, refsRes.rows);
        const stale = difference.length > 0;
        await client.query("COMMIT");

        if (!stale) return { result: original, stale: false };
        return {
          stale: true,
          result: {
            ...original,
            status: "stale",
            staleness: {
              detected_at: new Date().toISOString(),
              current_basis: fresh.basis,
              difference,
            },
          },
        };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    } finally {
      client.release();
    }
  }
}

function rowToNotice(r: Record<string, unknown>): EffectiveNotice {
  return {
    notice_id: r.notice_id as string,
    issuer: r.issuer as string,
    sequence: Number(r.sequence),
    revision: Number(r.revision),
    replaces: (r.replaces as string | null) ?? null,
    valid_from: (r.valid_from as Date).toISOString(),
    valid_until: (r.valid_until as Date).toISOString(),
    polygon: r.polygon as EffectiveNotice["polygon"],
    status: r.status as "active" | "revoked",
    batch_id: Number(r.batch_id),
  };
}

export function requestHash(request: DecisionRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

/** 键排序的稳定 JSON 序列化，用于幂等内容指纹。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * 比较冻结结论与当前重算结论，生成人类可复核的差异条目。
 * 仅当差异影响"结论或生效依据"时才算漂移（与本计划无关的新通告
 * 不会把 clear 打成 stale）。
 */
function diffBasis(
  original: DecisionResult,
  fresh: DecisionResult,
  frozenMaxBatch: number,
  allBatches: Array<Record<string, unknown>>,
): string[] {
  const diffs: string[] = [];

  if (fresh.status !== original.status) {
    diffs.push(`结论变化：${original.status} → ${fresh.status}`);
  }

  const origIds = new Set(original.basis.map((b) => b.notice_id));
  const freshIds = new Set(fresh.basis.map((b) => b.notice_id));
  for (const b of fresh.basis) {
    if (!origIds.has(b.notice_id)) diffs.push(`新生效依据：${b.notice_id}(rev ${b.revision})`);
  }
  for (const b of original.basis) {
    if (!freshIds.has(b.notice_id)) diffs.push(`依据退出：${b.notice_id}(rev ${b.revision})`);
  }

  // 快照中通告状态翻转（例如依据通告被撤销），即便重算几何结论相同也漂移。
  const frozen = new Map(
    original.snapshot.notice_versions.map((n) => [n.notice_id, n.status]),
  );
  for (const n of fresh.snapshot.notice_versions) {
    const was = frozen.get(n.notice_id);
    if (was && was !== n.status) {
      diffs.push(`通告 ${n.notice_id} 状态变化：${was} → ${n.status}`);
    }
  }
  for (const b of allBatches) {
    if (Number(b.id) > frozenMaxBatch) {
      const ref = b.batch_ref as string;
      // 仅当新批次带来的通告进入当前依据时才报（前面 basis 差已覆盖），
      // 纯无关批次不打扰值班员。
      if (fresh.basis.some((x) => !origIds.has(x.notice_id))) {
        diffs.push(`快照后发布新批次：${ref}`);
      }
    }
  }

  const o = original.first_intersection;
  const f = fresh.first_intersection;
  if ((o === null) !== (f === null)) {
    diffs.push("首个相交航段发生变化");
  } else if (o && f) {
    if (
      o.segment_index !== f.segment_index ||
      o.enters_at !== f.enters_at ||
      o.entry.lon !== f.entry.lon ||
      o.entry.lat !== f.entry.lat
    ) {
      diffs.push(
        `首个相交变化：航段${o.segment_index}@${o.enters_at} → 航段${f.segment_index}@${f.enters_at}`,
      );
    }
  }

  return [...new Set(diffs)];
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class FaultInjectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaultInjectedError";
  }
}

export type { NoticeBasis };
