import type { PoolClient } from "pg";
import type { DecisionResult, Reassessment, RouteRequest } from "../domain/types.js";

interface DecisionRow {
  decision_id: string;
  idempotency_key: string;
  status: string;
  request_hash: string;
  request_json: RouteRequest;
  result_json: DecisionResult;
  snapshot_max_publish_order: string | null;
  reassessment_json: Reassessment | null;
  created_at: Date;
}

export interface StoredDecision {
  decisionId: string;
  idempotencyKey: string;
  status: DecisionResult["status"];
  requestHash: string;
  request: RouteRequest;
  result: DecisionResult;
  snapshotMaxPublishOrder: number | null;
  reassessment: Reassessment | null;
  createdAt: string;
}

function mapRow(row: DecisionRow): StoredDecision {
  return {
    decisionId: row.decision_id,
    idempotencyKey: row.idempotency_key,
    status: row.status as StoredDecision["status"],
    requestHash: row.request_hash,
    request: row.request_json,
    result: row.result_json,
    snapshotMaxPublishOrder:
      row.snapshot_max_publish_order === null ? null : Number(row.snapshot_max_publish_order),
    reassessment: row.reassessment_json,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * 幂等插入：decision_id 与 idempotency_key 均有唯一约束。
 * 调用方在目录锁内已先行查重；若仍撞唯一约束则抛 23505，由服务层回滚后回读。
 */
export async function insertDecision(
  client: PoolClient,
  params: {
    request: RouteRequest;
    requestHash: string;
    result: DecisionResult;
  },
): Promise<StoredDecision> {
  const { request, requestHash, result } = params;
  const { rows } = await client.query<DecisionRow>(
    `insert into decisions
       (decision_id, idempotency_key, status, request_hash, request_json,
        result_json, snapshot_max_publish_order)
     values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
     returning *`,
    [
      request.decisionId,
      request.idempotencyKey,
      result.status,
      requestHash,
      JSON.stringify(request),
      JSON.stringify(result),
      result.snapshotMaxPublishOrder,
    ],
  );
  return mapRow(rows[0]!);
}

export async function getDecisionById(
  client: PoolClient,
  decisionId: string,
): Promise<StoredDecision | null> {
  const { rows } = await client.query<DecisionRow>(
    "select * from decisions where decision_id = $1",
    [decisionId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getDecisionByIdempotencyKey(
  client: PoolClient,
  key: string,
): Promise<StoredDecision | null> {
  const { rows } = await client.query<DecisionRow>(
    "select * from decisions where idempotency_key = $1",
    [key],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** 同事务写入快照关联（判定时使用的通告集合的可审计索引）。 */
export async function insertSnapshotLinks(
  client: PoolClient,
  decisionId: string,
  snapshot: Array<{ noticeId: string; publishOrder: number }>,
): Promise<void> {
  for (const item of snapshot) {
    await client.query(
      `insert into decision_snapshot_notices (decision_id, notice_id, publish_order)
       values ($1,$2,$3)
       on conflict do nothing`,
      [decisionId, item.noticeId, item.publishOrder],
    );
  }
}

export async function getSnapshotLinks(
  client: PoolClient,
  decisionId: string,
): Promise<Array<{ noticeId: string; publishOrder: number }>> {
  const { rows } = await client.query<{ notice_id: string; publish_order: string }>(
    "select notice_id, publish_order from decision_snapshot_notices where decision_id = $1 order by publish_order",
    [decisionId],
  );
  return rows.map((r) => ({ noticeId: r.notice_id, publishOrder: Number(r.publish_order) }));
}

/** 复算结论落库：仅把状态列置 stale；行内冻结结果 result_json 原样保留。 */
export async function markStaleWithReassessment(
  client: PoolClient,
  decisionId: string,
  reassessment: Reassessment,
): Promise<StoredDecision | null> {
  const { rows } = await client.query<DecisionRow>(
    `update decisions
       set status = 'stale',
           reassessment_json = $2::jsonb
     where decision_id = $1
     returning *`,
    [decisionId, JSON.stringify(reassessment)],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}
