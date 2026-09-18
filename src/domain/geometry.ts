import {
  COORD_DECIMALS,
  EARTH_RADIUS_METERS,
  METERS_PER_NAUTICAL_MILE,
  QUANTIZED_EPSILON,
  type Relation,
} from "./constants.js";
import type { LngLat } from "./types.js";

const q = (value: number): number => Number(value.toFixed(COORD_DECIMALS));

/** 按仓库精度量化坐标点。 */
export function quantizePoint([lng, lat]: LngLat): LngLat {
  return [q(lng), q(lat)];
}

export function quantizePolygon(polygon: LngLat[]): LngLat[] {
  return polygon.map(quantizePoint);
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** 两点大圆距离（米，haversine）。 */
export function haversineMeters(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 折线上相邻点距离（海里）。 */
export function segmentLengthsNauticalMiles(points: LngLat[]): number[] {
  const lengths: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    lengths.push(haversineMeters(points[i]!, points[i + 1]!) / METERS_PER_NAUTICAL_MILE);
  }
  return lengths;
}

function cross2(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/**
 * 线段 P0->P1 与多边形闭合边 A->B 的交点比例（沿航段方向，[0,1]）。
 * 共线重叠返回 null（交由边界滑行规则处理）。
 */
function edgeIntersection(
  p0x: number, p0y: number,
  p1x: number, p1y: number,
  ax: number, ay: number,
  bx: number, by: number,
): number | null {
  const rx = p1x - p0x;
  const ry = p1y - p0y;
  const sx = bx - ax;
  const sy = by - ay;
  const rxs = cross2(rx, ry, sx, sy);
  if (Math.abs(rxs) <= QUANTIZED_EPSILON * QUANTIZED_EPSILON) return null; // 平行/共线
  const qpx = ax - p0x;
  const qpy = ay - p0y;
  const t = cross2(qpx, qpy, sx, sy) / rxs;
  const u = cross2(qpx, qpy, rx, ry) / rxs;
  const e = QUANTIZED_EPSILON;
  if (t >= -e && t <= 1 + e && u >= -e && u <= 1 + e) {
    return Math.min(1, Math.max(0, t));
  }
  return null;
}

const pointEquals = (a: LngLat, b: LngLat): boolean =>
  Math.abs(a[0] - b[0]) <= QUANTIZED_EPSILON && Math.abs(a[1] - b[1]) <= QUANTIZED_EPSILON;

/** 射线法：点是否位于多边形内部（边界点返回 false）。 */
export function pointInPolygonInterior(point: LngLat, polygon: LngLat[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;
    const [xi, yi] = pi;
    const [xj, yj] = pj;
    const onEdge =
      Math.abs(cross2(xj - xi, yj - yi, x - xi, y - yi)) <=
        QUANTIZED_EPSILON * QUANTIZED_EPSILON &&
      x >= Math.min(xi, xj) - QUANTIZED_EPSILON &&
      x <= Math.max(xi, xj) + QUANTIZED_EPSILON &&
      y >= Math.min(yi, yj) - QUANTIZED_EPSILON &&
      y <= Math.max(yi, yj) + QUANTIZED_EPSILON;
    if (onEdge) return false;
    const intersects =
      yi > y + QUANTIZED_EPSILON !== yj > y + QUANTIZED_EPSILON &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export interface SegmentRelationResult {
  relation: Relation;
  /** 沿航段最早出现的关键点比例（穿越取入边点；纯相切取最早接触点）。 */
  firstAlong: number;
  /** 航段离开内部/接触的最晚比例（穿越取出边点；相切取最晚接触点）。 */
  lastAlong: number;
}

/**
 * 航段 P0->P1 相对多边形的关系：
 * - interior：航段穿越边界进入内部，或端点位于多边形内部；
 * - boundary：仅在边界接触——顶点触碰（含航段端点落在边界）或沿边滑行后离开；
 * - none：无接触。
 * firstAlong/lastAlong 给出沿航段的最早进入/最晚离开比例。
 * 坐标均已量化，比较使用 QUANTIZED_EPSILON。
 */
export function segmentPolygonRelation(p0: LngLat, p1: LngLat, polygon: LngLat[]): SegmentRelationResult {
  // 零长度航段：退化为点判定。
  if (pointEquals(p0, p1)) {
    if (pointInPolygonInterior(p0, polygon)) return { relation: "interior", firstAlong: 0, lastAlong: 0 };
    if (pointOnAnyEdge(p0, polygon)) return { relation: "boundary", firstAlong: 0, lastAlong: 0 };
    return { relation: "none", firstAlong: 1, lastAlong: 1 };
  }

  const startInside = pointInPolygonInterior(p0, polygon);
  const endInside = pointInPolygonInterior(p1, polygon);
  const crossings: number[] = [];
  const contacts: number[] = [];
  for (let i = 0; i < polygon.length - 1; i++) {
    const a = polygon[i]!;
    const b = polygon[i + 1]!;
    const t = edgeIntersection(p0[0], p0[1], p1[0], p1[1], a[0], a[1], b[0], b[1]);
    if (t === null) continue;
    const hit: LngLat = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
    // 交点落在多边形顶点上：相邻两边在航段异侧 => 穿越；同侧 => 顶点相切。
    if (pointEquals(hit, a) || pointEquals(hit, b)) {
      const vertex = pointEquals(hit, a) ? a : b;
      const idx = polygon.findIndex((v) => pointEquals(v, vertex));
      const prev = polygon[(idx - 1 + polygon.length - 1) % (polygon.length - 1)]!;
      const next = polygon[(idx + 1) % (polygon.length - 1)]!;
      const sPrev = cross2(p1[0] - p0[0], p1[1] - p0[1], prev[0] - vertex[0], prev[1] - vertex[1]);
      const sNext = cross2(p1[0] - p0[0], p1[1] - p0[1], next[0] - vertex[0], next[1] - vertex[1]);
      if (sPrev * sNext < -QUANTIZED_EPSILON * QUANTIZED_EPSILON) crossings.push(t);
      else contacts.push(t);
    } else {
      crossings.push(t); // 与边内部横截：穿越
    }
  }

  if (startInside || endInside || crossings.length >= 2) {
    const first = startInside
      ? 0
      : crossings.length > 0
        ? Math.min(...crossings)
        : 0;
    const last = endInside
      ? 1
      : crossings.length > 0
        ? Math.max(...crossings)
        : 1;
    return { relation: "interior", firstAlong: first, lastAlong: last };
  }
  // 端点在外却只有一个穿越点，说明顶点穿越判定退化，按边界相切处理。
  if (crossings.length === 1) return { relation: "boundary", firstAlong: crossings[0]!, lastAlong: crossings[0]! };
  if (contacts.length > 0) return { relation: "boundary", firstAlong: Math.min(...contacts), lastAlong: Math.max(...contacts) };
  // 共线沿边滑行（edgeIntersection 对共线返回 null）。
  if (segmentOnAnyEdge(p0, p1, polygon)) return { relation: "boundary", firstAlong: 0, lastAlong: 1 };
  return { relation: "none", firstAlong: 1, lastAlong: 1 };
}

function pointOnEdge(point: LngLat, a: LngLat, b: LngLat): boolean {
  return (
    Math.abs(cross2(b[0] - a[0], b[1] - a[1], point[0] - a[0], point[1] - a[1])) <=
      QUANTIZED_EPSILON * QUANTIZED_EPSILON &&
    point[0] >= Math.min(a[0], b[0]) - QUANTIZED_EPSILON &&
    point[0] <= Math.max(a[0], b[0]) + QUANTIZED_EPSILON &&
    point[1] >= Math.min(a[1], b[1]) - QUANTIZED_EPSILON &&
    point[1] <= Math.max(a[1], b[1]) + QUANTIZED_EPSILON
  );
}

function pointOnAnyEdge(point: LngLat, polygon: LngLat[]): boolean {
  for (let i = 0; i < polygon.length - 1; i++) {
    if (pointOnEdge(point, polygon[i]!, polygon[i + 1]!)) return true;
  }
  return false;
}

/** 航段与某条闭合边共线重叠（沿边滑行）：两端点落在同一条边上。 */
function segmentOnAnyEdge(p0: LngLat, p1: LngLat, polygon: LngLat[]): boolean {
  for (let i = 0; i < polygon.length - 1; i++) {
    const a = polygon[i]!;
    const b = polygon[i + 1]!;
    if (pointOnEdge(p0, a, b) && pointOnEdge(p1, a, b)) return true;
  }
  return false;
}
