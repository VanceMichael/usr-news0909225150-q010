import { segmentLengthsNauticalMiles } from "./geometry.js";
import type { LngLat } from "./types.js";

export interface TimedSegment {
  index: number;
  from: LngLat;
  to: LngLat;
  /** 进入该航段的时刻（epoch ms），左闭。 */
  startMs: number;
  /** 离开该航段的时刻（epoch ms），右开。 */
  endMs: number;
  durationMs: number;
}

/**
 * 按恒定航速把折线展开为带时间窗的航段序列。
 * 航段距离使用 haversine 大圆距离（海里），最后一个航段的 endMs 即航程结束时刻。
 */
export function buildTimeline(
  route: LngLat[],
  departureMs: number,
  speedKnots: number,
): TimedSegment[] {
  const lengths = segmentLengthsNauticalMiles(route);
  const segments: TimedSegment[] = [];
  let cursor = departureMs;
  for (let i = 0; i < lengths.length; i++) {
    const durationMs = (lengths[i]! / speedKnots) * 3_600_000;
    segments.push({
      index: i,
      from: route[i]!,
      to: route[i + 1]!,
      startMs: cursor,
      endMs: cursor + durationMs,
      durationMs,
    });
    cursor += durationMs;
  }
  return segments;
}

/** 航段上比例 fraction 处的坐标。 */
export function pointAt(segment: TimedSegment, fraction: number): LngLat {
  const t = Math.min(1, Math.max(0, fraction));
  return [
    segment.from[0] + (segment.to[0] - segment.from[0]) * t,
    segment.from[1] + (segment.to[1] - segment.from[1]) * t,
  ];
}
