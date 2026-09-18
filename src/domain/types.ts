import type { DecisionStatus, Relation } from "./constants.js";

/** [经度, 纬度]，WGS-84 / EPSG:4326，十进制度。 */
export type LngLat = [number, number];

/** 一份通告在某个 revision 上的不可变记录；status 为 revoked 表示该版本被撤销。 */
export interface NoticeRecord {
  noticeId: string;
  issuer: string;
  /** 签发机构内单调递增的通告序列（用于并发发布排序）。 */
  sequence: number;
  revision: number;
  /** 所替代的上一版本 notice_id；null 表示首发。 */
  replaces: string | null;
  validFrom: string;
  validUntil: string;
  polygon: LngLat[];
  status: "active" | "revoked";
  publishedAt: string;
  /** 全局发布全序（notices.publish_order），快照高水位依据。 */
  publishOrder: number;
}

/** 判定时真正生效的通告版本（版本链解析结果）。 */
export interface EffectiveNotice extends NoticeRecord {
  /** 本链首发 notice_id（replaces 链根）。 */
  rootId: string;
}

export interface RouteRequest {
  decisionId: string;
  idempotencyKey: string;
  departureAt: string;
  speedKnots: number;
  route: LngLat[];
}

/** 单个航段与单份通告的相交明细。 */
export interface SegmentIntersection {
  noticeId: string;
  rootId: string;
  segmentIndex: number;
  /** 进入管控区域（几何入边且通告生效）的时刻。 */
  enterAt: string;
  /** 离开（几何出边、航段结束或通告失效，取最早者）的时刻，右开。 */
  exitAt: string;
  relation: Relation;
  /** 沿航段方向的首个交点 [lng, lat]；内部经过时取航段入边点。 */
  point: LngLat;
  /** 交点距航段起点的比例 [0,1]。 */
  along: number;
  onBoundaryOnly: boolean;
}

export interface EffectiveBasis {
  noticeId: string;
  issuer: string;
  sequence: number;
  revision: number;
  replaces: string | null;
  validFrom: string;
  validUntil: string;
  status: "active" | "revoked";
  rootId: string;
}

export interface DecisionResult {
  decisionId: string;
  idempotencyKey: string;
  status: DecisionStatus;
  firstIntersection: SegmentIntersection | null;
  /** 航程时间窗内具有管辖权的版本（含已撤销版本，status 标明），按发布序列排序。 */
  effectiveNotices: EffectiveBasis[];
  /** needs_review 的人工复核原因（相切、链异常等）。 */
  reviewReasons: string[];
  departureAt: string;
  evaluatedAt: string;
  /** 一致性快照高水位（notices.publish_order）。 */
  snapshotMaxPublishOrder: number | null;
  /** 判定时使用的通告集合（完整冻结副本，复现用）。 */
  snapshotNoticeIds: string[];
  snapshotNotices: NoticeRecord[];
}

/** 历史决策复算结果。 */
export interface Reassessment {
  decisionId: string;
  basisCurrent: boolean;
  storedStatus: DecisionStatus;
  reassessedStatus: DecisionStatus;
  reassessed: DecisionResult;
}
