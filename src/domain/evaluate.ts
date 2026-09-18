import { DECISION_STATUSES, type DecisionStatus } from "./constants.js";
import {
  quantizePoint,
  quantizePolygon,
  segmentPolygonRelation,
} from "./geometry.js";
import { buildTimeline, pointAt, type TimedSegment } from "./time.js";
import { buildChains, chainTimeline, type ActiveInterval } from "./versions.js";
import type {
  DecisionResult,
  EffectiveBasis,
  LngLat,
  NoticeRecord,
  RouteRequest,
  SegmentIntersection,
} from "./types.js";

export interface EvaluateInput {
  request: RouteRequest;
  /** 一致性快照内的全部通告（按发布时刻冻结）。 */
  snapshotNotices: NoticeRecord[];
  snapshotMaxPublishOrder: number | null;
  evaluatedAt: string;
}

interface Candidate {
  segment: TimedSegment;
  interval: ActiveInterval;
  intersection: SegmentIntersection;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function toBasis(interval: ActiveInterval): EffectiveBasis {
  const n = interval.notice;
  return {
    noticeId: n.noticeId,
    issuer: n.issuer,
    sequence: n.sequence,
    revision: n.revision,
    replaces: n.replaces,
    validFrom: n.validFrom,
    validUntil: n.validUntil,
    status: n.status,
    rootId: n.rootId,
  };
}

function segmentAt(segment: TimedSegment, ms: number): number {
  if (segment.durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, (ms - segment.startMs) / segment.durationMs));
}

/**
 * 纯函数判定核心：给定冻结的通告快照与航线请求，产出可复核结论。
 * 不访问数据库/时钟，便于复现与测试。
 */
export function evaluate(input: EvaluateInput): DecisionResult {
  const { request, snapshotNotices, snapshotMaxPublishOrder, evaluatedAt } = input;
  const departureMs = new Date(request.departureAt).getTime();
  const route = request.route.map(quantizePoint);
  const timeline = buildTimeline(route, departureMs, request.speedKnots);
  const windowStartMs = timeline[0]!.startMs;
  const windowEndMs = timeline[timeline.length - 1]!.endMs;

  const chains = buildChains(snapshotNotices);
  const timelines = chains.map((c) => chainTimeline(c, windowStartMs, windowEndMs));

  const effectiveNotices: EffectiveBasis[] = [];
  const candidates: Candidate[] = [];
  const reviewReasons = new Set<string>();

  for (const tl of timelines) {
    for (const issue of tl.issues) reviewReasons.add(issue.message);

    const touchesWindow =
      tl.active.some((a) => a.endMs > windowStartMs && a.startMs < windowEndMs) ||
      tl.covered.some((c) => c.endMs > windowStartMs && c.startMs < windowEndMs);
    if (!touchesWindow) continue;

    // 生效依据：窗口内具有管辖权的版本（撤销版本保留并以 status 标明）。
    for (const coverage of tl.covered) {
      effectiveNotices.push(toBasis({
        notice: coverage.notice,
        startMs: coverage.startMs,
        endMs: coverage.endMs,
      }));
    }

    for (const interval of tl.active) {
      const polygon = quantizePolygon(interval.notice.polygon);
      for (const segment of timeline) {
        const rel = segmentPolygonRelation(segment.from, segment.to, polygon);
        if (rel.relation === "none") continue;

        // 几何进出时刻 = 航段时间线上 firstAlong/lastAlong 对应时刻。
        const geomEnterMs = segment.startMs + rel.firstAlong * segment.durationMs;
        const geomExitMs = segment.startMs + rel.lastAlong * segment.durationMs;
        // 最早接触点必须落在通告管辖区间（左闭右开）内，否则船到时该版本已失效/未生效。
        if (geomEnterMs < interval.startMs || geomEnterMs >= interval.endMs) continue;

        if (rel.relation === "boundary") {
          // 相切可能只是一瞬间（顶点触碰）：enter=exit 为该瞬间，仍需人工复核。
          const enterMs = geomEnterMs;
          const exitMs = Math.max(geomExitMs, geomEnterMs);
          const intersection: SegmentIntersection = {
            noticeId: interval.notice.noticeId,
            rootId: interval.notice.rootId,
            segmentIndex: segment.index,
            enterAt: iso(enterMs),
            exitAt: iso(exitMs),
            relation: "boundary",
            point: quantizePoint(pointAt(segment, rel.firstAlong)),
            along: Number(rel.firstAlong.toFixed(9)),
            onBoundaryOnly: true,
          };
          reviewReasons.add(
            `航段 ${segment.index} 与通告 ${interval.notice.noticeId} 仅边界相切于 ` +
              `(${intersection.point[0]},${intersection.point[1]})，时刻 ${intersection.enterAt}`,
          );
          continue;
        }

        // interior：几何停留区间与管辖区间求交，交点必须真正落在“通告有效”的时刻。
        const enterMs = Math.max(geomEnterMs, interval.startMs, segment.startMs);
        const exitMs = Math.min(geomExitMs, interval.endMs, segment.endMs);
        if (exitMs <= enterMs) continue;
        const enterAlong = segmentAt(segment, enterMs);
        const intersection: SegmentIntersection = {
          noticeId: interval.notice.noticeId,
          rootId: interval.notice.rootId,
          segmentIndex: segment.index,
          enterAt: iso(enterMs),
          exitAt: iso(exitMs),
          relation: "interior",
          point: quantizePoint(pointAt(segment, enterAlong)),
          along: Number(enterAlong.toFixed(9)),
          onBoundaryOnly: false,
        };
        candidates.push({ segment, interval, intersection });
      }
    }
  }

  effectiveNotices.sort((a, b) => a.sequence - b.sequence || a.revision - b.revision);
  dedupeBasis(effectiveNotices);

  let status: DecisionStatus;
  if (reviewReasons.size > 0) {
    status = "needs_review";
  } else if (candidates.length > 0) {
    status = "restricted";
  } else {
    status = "clear";
  }

  let firstIntersection: SegmentIntersection | null = null;
  if (candidates.length > 0) {
    candidates.sort((x, y) => {
      const tx = new Date(x.intersection.enterAt).getTime();
      const ty = new Date(y.intersection.enterAt).getTime();
      if (tx !== ty) return tx - ty;
      if (x.segment.index !== y.segment.index) return x.segment.index - y.segment.index;
      return x.intersection.along - y.intersection.along;
    });
    firstIntersection = candidates[0]!.intersection;
  }

  return {
    decisionId: request.decisionId,
    idempotencyKey: request.idempotencyKey,
    status,
    firstIntersection,
    effectiveNotices,
    reviewReasons: [...reviewReasons],
    departureAt: request.departureAt,
    evaluatedAt,
    snapshotMaxPublishOrder,
    snapshotNoticeIds: snapshotNotices.map((n) => n.noticeId).sort(),
    snapshotNotices,
  };
}

function dedupeBasis(list: EffectiveBasis[]): void {
  const seen = new Set<string>();
  for (let i = list.length - 1; i >= 0; i--) {
    const key = list[i]!.rootId + "#" + list[i]!.noticeId;
    if (seen.has(key)) list.splice(i, 1);
    else seen.add(key);
  }
}

export function isValidStatus(status: string): status is DecisionStatus {
  return (DECISION_STATUSES as readonly string[]).includes(status);
}

/** 请求规范化哈希载荷（字段顺序固定）。 */
export function canonicalRequestJson(request: RouteRequest): string {
  return JSON.stringify({
    decision_id: request.decisionId,
    idempotency_key: request.idempotencyKey,
    departure_at: request.departureAt,
    speed_knots: request.speedKnots,
    route: request.route,
  });
}

export type { LngLat };
