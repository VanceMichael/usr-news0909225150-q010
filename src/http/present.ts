import type { DecisionResult, Reassessment } from "../domain/types.js";

/** HTTP 边界统一使用 snake_case（与 contracts/route-check.schema.json 一致）。 */
export function presentDecision(d: DecisionResult): Record<string, unknown> {
  return {
    decision_id: d.decisionId,
    idempotency_key: d.idempotencyKey,
    status: d.status,
    first_intersection: d.firstIntersection === null ? null : {
      notice_id: d.firstIntersection.noticeId,
      root_id: d.firstIntersection.rootId,
      segment_index: d.firstIntersection.segmentIndex,
      enter_at: d.firstIntersection.enterAt,
      exit_at: d.firstIntersection.exitAt,
      relation: d.firstIntersection.relation,
      point: d.firstIntersection.point,
      along: d.firstIntersection.along,
      on_boundary_only: d.firstIntersection.onBoundaryOnly,
    },
    effective_notices: d.effectiveNotices.map((n) => ({
      notice_id: n.noticeId,
      issuer: n.issuer,
      sequence: n.sequence,
      revision: n.revision,
      replaces: n.replaces,
      valid_from: n.validFrom,
      valid_until: n.validUntil,
      status: n.status,
      root_id: n.rootId,
    })),
    review_reasons: d.reviewReasons,
    departure_at: d.departureAt,
    evaluated_at: d.evaluatedAt,
    snapshot_max_publish_order: d.snapshotMaxPublishOrder,
    snapshot_notice_ids: d.snapshotNoticeIds,
    snapshot_notices: d.snapshotNotices.map((n) => ({
      notice_id: n.noticeId,
      issuer: n.issuer,
      sequence: n.sequence,
      revision: n.revision,
      replaces: n.replaces,
      valid_from: n.validFrom,
      valid_until: n.validUntil,
      polygon: n.polygon,
      status: n.status,
      published_at: n.publishedAt,
      publish_order: n.publishOrder,
    })),
  };
}

export function presentReassessment(r: Reassessment): Record<string, unknown> {
  return {
    decision_id: r.decisionId,
    basis_current: r.basisCurrent,
    stored_status: r.storedStatus,
    reassessed_status: r.reassessedStatus,
    reassessed: presentDecision(r.reassessed),
  };
}
