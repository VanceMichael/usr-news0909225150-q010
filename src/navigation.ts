/**
 * 航行时间推算：恒向线（rhumb line）海里里程 + 恒定航速。
 *
 * - 距离按恒向线公式计算，1 海里 = 1852 米，地球半径取 3440.065 NM；
 * - 计划航速 speed_knots 在全程恒定；
 * - 航段 k 的时间窗 = [departure + 累计里程/航速, +本航段里程/航速)，
 *   航段内任意比例 t 的时刻线性插值。
 */
import { type LonLat } from "./precision.js";

const EARTH_RADIUS_NM = 3440.065;

function rhumbDistanceNm(a: LonLat, b: LonLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  let Δφ = φ2 - φ1;
  let Δλ = toRad(Math.abs(lon2 - lon1));
  // 跨越日期变更线时取短弧。
  if (Δλ > Math.PI) Δλ = 2 * Math.PI - Δλ;
  const Δψ = Math.log(
    Math.tan(Math.PI / 4 + φ2 / 2) / Math.tan(Math.PI / 4 + φ1 / 2),
  );
  // 东西方向分量：等纬航线段 Δψ≈0，q 退化为 cosφ。
  const q = Math.abs(Δψ) > 1e-12 ? Δφ / Δψ : Math.cos(φ1);
  // 南北向恰好越过极点等异常情形由 q 的有限性兜底。
  const qFinite = Number.isFinite(q) && q !== 0 ? q : 1e-12;
  return Math.sqrt((Δλ * qFinite) ** 2 + Δφ ** 2) * EARTH_RADIUS_NM;
}

export interface TimedSegment {
  index: number;
  from: LonLat;
  to: LonLat;
  distanceNm: number;
  /** 航段进入时刻（纪元毫秒）。 */
  entersAt: number;
  /** 航段离开时刻（纪元毫秒）。 */
  exitsAt: number;
}

export interface Schedule {
  departure: number;
  speedKnots: number;
  segments: TimedSegment[];
  /** 航线全程结束时刻。 */
  arrivesAt: number;
  /** 航段 index 内比例 t 处的时刻。 */
  timeAt: (index: number, t: number) => number;
}

export function buildSchedule(
  route: readonly LonLat[],
  departure: Date,
  speedKnots: number,
): Schedule {
  if (!Number.isFinite(speedKnots) || speedKnots <= 0) {
    throw new Error("航速必须为正数");
  }
  const segments: TimedSegment[] = [];
  let cursor = departure.getTime();
  for (let i = 0; i < route.length - 1; i++) {
    const from = route[i]!;
    const to = route[i + 1]!;
    const distanceNm = rhumbDistanceNm(from, to);
    const durationMs = (distanceNm / speedKnots) * 3_600_000;
    const entersAt = cursor;
    const exitsAt = cursor + durationMs;
    segments.push({ index: i, from, to, distanceNm, entersAt, exitsAt });
    cursor = exitsAt;
  }
  return {
    departure: departure.getTime(),
    speedKnots,
    segments,
    arrivesAt: cursor,
    timeAt: (index, t) => {
      const seg = segments[index];
      if (!seg) throw new Error(`航段 ${index} 不存在`);
      return seg.entersAt + t * (seg.exitsAt - seg.entersAt);
    },
  };
}
