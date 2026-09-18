/**
 * 二维几何：航段与闭合多边形的相交判定。
 *
 * 全部运算在经度/纬度角度平面内进行（管制区尺度远小于地球曲率
 * 尺度），比较一律使用 precision.ts 约定的坐标容差：
 *
 * - 多边形为闭合环，边界属于区域内部（含边界）；
 * - 航段穿入内部或与边重合/沿边界航行 => 相交区间（inside）；
 * - 航段只在单个点接触（顶点擦过、切线接触），两侧均在区域外
 *   => 记为相切点（tangent），交由 needs_review；
 * - 完全不相交 => null。
 */
import { COORD_EPS, type LonLat } from "./precision.js";

/** 平行/共线判定的叉积容差（度²尺度）。 */
const PARALLEL_EPS = COORD_EPS;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function cross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number,
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** 点 P 是否落在 AB 线段范围内（假定已共线）。 */
function onSegmentCollinear(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number,
): boolean {
  return (
    px >= Math.min(ax, bx) - COORD_EPS &&
    px <= Math.max(ax, bx) + COORD_EPS &&
    py >= Math.min(ay, by) - COORD_EPS &&
    py <= Math.max(ay, by) + COORD_EPS
  );
}

/**
 * 点在多边形中的位置。
 * @returns 2 = 在边界上，1 = 在内部，0 = 在外部
 */
export function pointInPolygon(p: LonLat, ring: readonly LonLat[]): 0 | 1 | 2 {
  const [px, py] = p;
  let inside = false;

  // 环首尾重合，边取 ring[i] -> ring[i+1]（i < n-1）。
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i, i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const [ax, ay] = a;
    const [bx, by] = b;

    // 边界距离判定：|AB × AP| ≈ 0 且 P 位于 AB 包围盒内。
    const crossValue = cross(ax, ay, bx, by, px, py);
    if (Math.abs(crossValue) <= PARALLEL_EPS && onSegmentCollinear(px, py, ax, ay, bx, by)) {
      return 2;
    }

    // 射线法（向右水平射线），顶点采用"下端点计入"约定。
    const intersects =
      ay > py !== by > py &&
      px < ((bx - ax) * (py - ay)) / (by - ay) + ax;
    if (intersects) inside = !inside;
  }

  return inside ? 1 : 0;
}

/** 线段 AB 与 CD 的交点参数（t 沿 AB，u 沿 CD）。 */
function edgeCrossing(
  a: LonLat, b: LonLat, c: LonLat, d: LonLat,
): { t: number; u: number } | "collinear" | null {
  const [ax, ay] = a;
  const [bx, by] = b;
  const [cx, cy] = c;
  const [dx, dy] = d;
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const den = rx * sy - ry * sx;

  if (Math.abs(den) <= PARALLEL_EPS) {
    // 共线时由调用方按包围盒处理。
    if (Math.abs((cx - ax) * ry - (cy - ay) * rx) <= PARALLEL_EPS) return "collinear";
    return null;
  }

  const qpx = cx - ax;
  const qpy = cy - ay;
  const t = (qpx * sy - qpy * sx) / den;
  const u = (qpx * ry - qpy * rx) / den;
  if (t < -COORD_EPS || t > 1 + COORD_EPS || u < -COORD_EPS || u > 1 + COORD_EPS) return null;
  return { t: clamp01(t), u: clamp01(u) };
}

export interface SegmentIntersection {
  /** 进入点沿航段的参数 [0,1]。 */
  tEntry: number;
  /** 离开点参数；与 tEntry 相等表示单点接触。 */
  tExit: number;
  /** 仅单点相切（未进入区域内部）。 */
  tangent: boolean;
}

/**
 * 求航段 AB 与闭合多边形环的首个相交结果。
 * 返回进入/离开参数；相切时 tEntry === tExit 且 tangent=true。
 */
export function segmentPolygonIntersection(
  a: LonLat,
  b: LonLat,
  ring: readonly LonLat[],
): SegmentIntersection | null {
  // 收集所有事件参数（穿越点、共线重叠端点、航段两端）。
  const events = new Set<number>([0, 1]);
  let hasCollinearOverlap = false;

  for (let i = 0; i < ring.length - 1; i++) {
    const c = ring[i]!;
    const d = ring[i + 1]!;
    const hit = edgeCrossing(a, b, c, d);
    if (hit === null) continue;
    if (hit === "collinear") {
      // 求 C、D 在 AB 方向上的未裁剪投影参数。
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const len2 = vx * vx + vy * vy;
      if (len2 > COORD_EPS) {
        const project = (q: LonLat) =>
          ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / len2;
        const tLo = Math.min(project(c), project(d));
        const tHi = Math.max(project(c), project(d));
        // 与航段参数域 [0,1] 的实际重叠。
        const overlapLo = Math.max(tLo, 0);
        const overlapHi = Math.min(tHi, 1);
        if (overlapHi - overlapLo > COORD_EPS) {
          events.add(overlapLo);
          events.add(overlapHi);
          hasCollinearOverlap = true;
        } else if (overlapHi + COORD_EPS >= overlapLo && overlapHi <= 1 + COORD_EPS && overlapLo <= 1 + COORD_EPS) {
          // 共线单点接触（端点相接），作为候选相切事件。
          events.add(Math.min(1, Math.max(0, (overlapLo + overlapHi) / 2)));
        }
      }
      continue;
    }
    events.add(hit.t);
  }

  const sorted = [...events].sort((x, y) => x - y);
  // 合并精度内重合的事件点。
  const params: number[] = [];
  for (const t of sorted) {
    if (params.length === 0 || Math.abs(t - params[params.length - 1]!) > COORD_EPS) params.push(t);
  }

  const pointAt = (t: number): LonLat => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];

  // 逐开区间抽样，中点在内/在边界上 => 该区间位于区域内。
  const insideIntervals: Array<[number, number]> = [];
  for (let i = 0; i < params.length - 1; i++) {
    const lo = params[i]!;
    const hi = params[i + 1]!;
    const mid = (lo + hi) / 2;
    if (pointInPolygon(pointAt(mid), ring) !== 0) {
      insideIntervals.push([lo, hi]);
    }
  }

  if (insideIntervals.length > 0) {
    const first = mergeIntervals(insideIntervals)[0]!;
    return { tEntry: first[0], tExit: first[1], tangent: false };
  }

  // 没有任何区间进入内部：事件点若落在边界上即相切点。
  const touchParams = params.filter(
    (t) => pointInPolygon(pointAt(t), ring) === 2,
  );
  if (touchParams.length > 0) {
    return { tEntry: touchParams[0]!, tExit: touchParams[0]!, tangent: true };
  }
  return null;
}

/** 合并相交/相邻的数值区间。 */
export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [[...sorted[0]!] as [number, number]];
  for (const [lo, hi] of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (lo <= last[1] + COORD_EPS) {
      if (hi > last[1]) last[1] = hi;
    } else {
      merged.push([lo, hi]);
    }
  }
  return merged;
}

/** 时间区间（毫秒纪元值）是否有交集；半开区间 [from, until)。 */
export function halfOpenOverlap(
  fromA: number, untilA: number, fromB: number, untilB: number,
): boolean {
  return fromA < untilB && fromB < untilA;
}
