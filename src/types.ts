import type { LonLat } from "./precision.js";

/** 通告发布/撤销操作（一个批次内原子生效）。 */
export interface PublishOp {
  op: "publish";
  notice: NoticeInput;
}

export interface RevokeOp {
  op: "revoke";
  notice_id: string;
}

export type BatchOp = PublishOp | RevokeOp;

export interface BatchInput {
  batch_ref: string;
  ops: BatchOp[];
}

export interface NoticeInput {
  notice_id: string;
  issuer: string;
  sequence: number;
  revision: number;
  replaces: string | null;
  valid_from: string;
  valid_until: string;
  polygon: LonLat[];
}

/** 快照中可直接参与判定的有效通告形态。 */
export interface EffectiveNotice {
  notice_id: string;
  issuer: string;
  sequence: number;
  revision: number;
  replaces: string | null;
  valid_from: string;
  valid_until: string;
  polygon: LonLat[];
  status: "active" | "revoked";
  batch_id: number;
}

export interface DecisionRequest {
  decision_id: string;
  idempotency_key: string;
  departure_at: string;
  speed_knots: number;
  route: LonLat[];
}

export type Verdict = "clear" | "restricted" | "needs_review";

export interface IntersectionPoint {
  segment_index: number;
  at: string;
  lon: number;
  lat: number;
  /** 沿航段的比例参数，保留复核轨迹。 */
  t: number;
}

export interface IntersectionDetail {
  kind: "inside" | "boundary_tangent";
  segment_index: number;
  enters_at: string;
  exits_at: string;
  entry: IntersectionPoint;
  exit: IntersectionPoint;
}

export interface NoticeBasis {
  notice_id: string;
  issuer: string;
  sequence: number;
  revision: number;
  replaces: string | null;
  status: "active" | "revoked";
  valid_from: string;
  valid_until: string;
  batch_id: number;
}

export interface DecisionResult {
  decision_id: string;
  status: Verdict | "stale";
  evaluated_at: string;
  departure_at: string;
  first_intersection: IntersectionDetail | null;
  /** 判定依据：首个相交时刻实际生效的通告版本。 */
  basis: NoticeBasis[];
  review_notes: string[];
  snapshot: {
    batch_refs: string[];
    notice_versions: Array<Pick<NoticeBasis, "notice_id" | "issuer" | "sequence" | "revision" | "status">>;
  };
  /** recheck 发现通告集合已变化时附带。 */
  staleness?: {
    detected_at: string;
    current_basis: NoticeBasis[];
    difference: string[];
  };
}
