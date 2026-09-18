import { COORD_DECIMALS } from "./constants.js";
import type { LngLat, NoticeRecord, RouteRequest } from "./types.js";

export class ValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const finiteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

function parseLngLat(value: unknown, label: string): LngLat {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ValidationError(`${label} 必须为 [经度, 纬度] 二元组`);
  }
  const [lng, lat] = value;
  if (!finiteNumber(lng) || !finiteNumber(lat)) {
    throw new ValidationError(`${label} 坐标必须为有限数字`);
  }
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    throw new ValidationError(`${label} 坐标越界（经度 ±180、纬度 ±90）`);
  }
  return [Number(lng.toFixed(COORD_DECIMALS)), Number(lat.toFixed(COORD_DECIMALS))];
}

/** 按 contracts/route-check.schema.json 校验并归一化判定请求。 */
export function parseRouteRequest(body: unknown): RouteRequest {
  if (typeof body !== "object" || body === null) {
    throw new ValidationError("请求体必须为 JSON 对象");
  }
  const b = body as Record<string, unknown>;
  for (const field of ["decision_id", "idempotency_key", "departure_at", "speed_knots", "route"]) {
    if (!(field in b)) throw new ValidationError(`缺少必填字段 ${field}`);
  }
  if (typeof b.decision_id !== "string" || b.decision_id.length === 0) {
    throw new ValidationError("decision_id 必须为非空字符串");
  }
  if (typeof b.idempotency_key !== "string" || b.idempotency_key.length === 0) {
    throw new ValidationError("idempotency_key 必须为非空字符串");
  }
  const departureMs = Date.parse(b.departure_at as string);
  if (!Number.isFinite(departureMs)) {
    throw new ValidationError("departure_at 必须为合法 date-time");
  }
  if (!finiteNumber(b.speed_knots) || b.speed_knots <= 0) {
    throw new ValidationError("speed_knots 必须为正数");
  }
  if (!Array.isArray(b.route) || b.route.length < 2) {
    throw new ValidationError("route 至少包含 2 个航点");
  }
  const route = b.route.map((p, i) => parseLngLat(p, `route[${i}]`));
  return {
    decisionId: b.decision_id,
    idempotencyKey: b.idempotency_key,
    departureAt: new Date(departureMs).toISOString(),
    speedKnots: b.speed_knots,
    route,
  };
}

export interface NoticeInput {
  noticeId: string;
  issuer: string;
  sequence: number;
  revision: number;
  replaces: string | null;
  validFrom: string;
  validUntil: string;
  polygon: LngLat[];
  status: "active" | "revoked";
}

/** 校验通告发布载荷（版本链闭合在事务内对照库内状态再查一次）。 */
export function parseNoticeInput(body: unknown): NoticeInput {
  if (typeof body !== "object" || body === null) {
    throw new ValidationError("请求体必须为 JSON 对象");
  }
  const b = body as Record<string, unknown>;
  for (const field of ["notice_id", "issuer", "sequence", "revision", "valid_from", "valid_until", "polygon"]) {
    if (!(field in b)) throw new ValidationError(`缺少必填字段 ${field}`);
  }
  const noticeId = b.notice_id;
  const issuer = b.issuer;
  if (typeof noticeId !== "string" || !noticeId) throw new ValidationError("notice_id 必须为非空字符串");
  if (typeof issuer !== "string" || !issuer) throw new ValidationError("issuer 必须为非空字符串");
  if (!finiteNumber(b.sequence) || b.sequence <= 0 || !Number.isInteger(b.sequence)) {
    throw new ValidationError("sequence 必须为正整数");
  }
  if (!finiteNumber(b.revision) || b.revision < 1 || !Number.isInteger(b.revision)) {
    throw new ValidationError("revision 必须为 >=1 的整数");
  }
  const replaces = b.replaces === undefined || b.replaces === null ? null : b.replaces;
  if (replaces !== null && typeof replaces !== "string") {
    throw new ValidationError("replaces 必须为字符串或 null");
  }
  const fromMs = Date.parse(b.valid_from as string);
  const untilMs = Date.parse(b.valid_until as string);
  if (!Number.isFinite(fromMs) || !Number.isFinite(untilMs)) {
    throw new ValidationError("valid_from/valid_until 必须为合法 date-time");
  }
  if (untilMs <= fromMs) throw new ValidationError("valid_until 必须晚于 valid_from（左闭右开）");
  if (!Array.isArray(b.polygon) || b.polygon.length < 4) {
    throw new ValidationError("polygon 至少为 4 个点且首尾闭合的环");
  }
  const polygon = b.polygon.map((p, i) => parseLngLat(p, `polygon[${i}]`));
  const first = polygon[0]!;
  const last = polygon[polygon.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw new ValidationError("polygon 必须首尾闭合（首点 == 末点，按 1e-7 精度量化）");
  }
  const status = b.status === undefined || b.status === "active"
    ? "active"
    : b.status === "revoked"
      ? "revoked"
      : null;
  if (status === null) throw new ValidationError("status 仅允许 active / revoked");
  return {
    noticeId,
    issuer,
    sequence: b.sequence,
    revision: b.revision,
    replaces,
    validFrom: new Date(fromMs).toISOString(),
    validUntil: new Date(untilMs).toISOString(),
    polygon,
    status,
  };
}

/** 发布前的链内一致性（调用方持有快照锁）。 */
export function assertRevisionLink(parent: NoticeRecord | null, input: NoticeInput): void {
  if (input.replaces === null) {
    if (input.revision !== 1) throw new ValidationError("首发通告 revision 必须为 1");
    return;
  }
  if (!parent) throw new ValidationError(`replaces 指向的 ${input.replaces} 不存在`);
  if (parent.issuer !== input.issuer) {
    throw new ValidationError("更正通告必须与原通告同一签发机构");
  }
  if (input.revision !== parent.revision + 1) {
    throw new ValidationError(`revision 必须接续：${input.replaces} 为 revision ${parent.revision}`);
  }
  if (parent.status === "revoked") {
    throw new ValidationError("已撤销版本不得再被更正（链终止于撤销）");
  }
}
