/**
 * 纯判定引擎：在给定通告集合（一致性快照的内容）上计算航线结论。
 *
 * 版本解析规则（同一签发机构内，按 sequence 建立版本链）：
 *  - revision 递增，replaces 指向前一版本；
 *  - 链上"后续且当前未撤销"的版本在其有效期内替代旧版本：
 *    每份通告的实际有效窗口 = 自身 [valid_from, valid_until)
 *    减去所有同机构后续未撤销版本窗口的并集。因此旧版本在更正
 *    生效时刻被精确截断，不会出现跨版本混合时段；
 *  - 撤销（revoked）只废止被点名的那份通告，不回溯恢复其旧版本；
 *    若更正本身被撤销，旧版本的有效窗口恢复完整。
 *
 * 时间窗为半开区间 [valid_from, valid_until)，故 valid_until 时刻
 * 精确离开区域（支持跨午夜通告：23:59:59 与次日 00:00:00 衔接）。
 */
import { segmentPolygonIntersection } from "./geometry.js";
import { buildSchedule } from "./navigation.js";
import { roundPoint, type LonLat } from "./precision.js";
import type {
  DecisionRequest,
  DecisionResult,
  EffectiveNotice,
  IntersectionDetail,
  NoticeBasis,
} from "./types.js";

interface NoticeVersion {
  notice: EffectiveNotice;
  /** 该版本真正生效的半开时间窗（已扣除后续版本、撤销状态）。 */
  windows: Array<[number, number]>;
}

const epoch = (text: string) => Date.parse(text);
const iso = (ms: number) => new Date(ms).toISOString();

/** 按 (issuer, sequence) 建立版本链并计算每份通告的有效窗口。 */
export function resolveVersionChain(notices: EffectiveNotice[]): NoticeVersion[] {
  const byIssuer = new Map<string, EffectiveNotice[]>();
  for (const n of notices) {
    const list = byIssuer.get(n.issuer) ?? [];
    list.push(n);
    byIssuer.set(n.issuer, list);
  }

  const result: NoticeVersion[] = [];
  for (const list of byIssuer.values()) {
    const ordered = [...list].sort((a, b) => a.sequence - b.sequence);
    for (const n of ordered) {
      if (n.status === "revoked") {
        result.push({ notice: n, windows: [] });
        continue;
      }
      // 自身窗口减去同机构后续未撤销版本窗口的并集。
      let windows: Array<[number, number]> = [[epoch(n.valid_from), epoch(n.valid_until)]];
      for (const later of ordered) {
        if (later.sequence <= n.sequence || later.status === "revoked") continue;
        windows = subtractWindows(windows, [epoch(later.valid_from), epoch(later.valid_until)]);
      }
      result.push({ notice: n, windows });
    }
  }
  // 保持稳定输出顺序（issuer、sequence）。
  result.sort(
    (a, b) =>
      a.notice.issuer.localeCompare(b.notice.issuer) ||
      a.notice.sequence - b.notice.sequence,
  );
  return result;
}

/** 从一组半开窗口中减去单个窗口 [cutFrom, cutUntil)。 */
function subtractWindows(
  windows: Array<[number, number]>,
  cut: [number, number],
): Array<[number, number]> {
  const [cutFrom, cutUntil] = cut;
  const out: Array<[number, number]> = [];
  for (const [from, until] of windows) {
    if (cutUntil <= from || cutFrom >= until) {
      out.push([from, until]);
      continue;
    }
    if (cutFrom > from) out.push([from, Math.min(cutFrom, until)]);
    if (cutUntil < until) out.push([Math.max(cutUntil, from), until]);
  }
  return out.filter(([f, u]) => f < u);
}

function toBasis(n: EffectiveNotice): NoticeBasis {
  return {
    notice_id: n.notice_id,
    issuer: n.issuer,
    sequence: n.sequence,
    revision: n.revision,
    replaces: n.replaces,
    status: n.status,
    valid_from: n.valid_from,
    valid_until: n.valid_until,
    batch_id: n.batch_id,
  };
}

interface TangentHit {
  segIndex: number;
  t: number;
  at: number;
  notice: EffectiveNotice;
}

interface InsideHit {
  segIndex: number;
  /** 该版本实际生效的相交子时段。 */
  fromMs: number;
  untilMs: number;
  /** 与子时段端点对应的航段比例参数。 */
  tFrom: number;
  tUntil: number;
  notice: EffectiveNotice;
  /** 几何相交在本航段上的完整参数范围（供核对版本接管）。 */
  tEntry: number;
  tExit: number;
}

export interface EvaluationInput {
  request: DecisionRequest;
  notices: EffectiveNotice[];
  snapshotRefs: { batch_refs: string[] };
  evaluatedAt: Date;
}

/**
 * 执行一次判定。结果确定后由数据库层落盘；本函数不做任何 IO，
 * 因此重启后可用同样的快照内容逐字节复现。
 */
export function evaluate(input: EvaluationInput): DecisionResult {
  const { request, evaluatedAt } = input;
  const departure = new Date(request.departure_at);
  if (Number.isNaN(departure.getTime())) throw new Error("departure_at 不是合法时间");

  const route = request.route.map((p) => roundPoint(p as LonLat));
  for (const p of route) {
    if (p[0] < -180 || p[0] > 180 || p[1] < -90 || p[1] > 90) {
      throw new Error("航线坐标超出经纬度范围");
    }
  }
  if (route.length < 2) throw new Error("航线至少包含两个点");

  const polygonOf = (n: EffectiveNotice): LonLat[] =>
    n.polygon.map((p) => roundPoint(p as LonLat));

  const schedule = buildSchedule(route, departure, request.speed_knots);
  const versions = resolveVersionChain(input.notices);
  const reviewNotes: string[] = [];
  const tangentHits: TangentHit[] = [];
  const insideCandidates: InsideHit[] = [];

  for (const seg of schedule.segments) {
    for (const version of versions) {
      const hit = segmentPolygonIntersection(seg.from, seg.to, polygonOf(version.notice));
      if (!hit) continue;

      if (hit.tangent) {
        const at = schedule.timeAt(seg.index, hit.tEntry);
        if (version.windows.some(([f, u]) => at >= f && at < u)) {
          tangentHits.push({ segIndex: seg.index, t: hit.tEntry, at, notice: version.notice });
          reviewNotes.push(
            `航段 ${seg.index} 于 ${iso(at)} 与通告 ${version.notice.notice_id} 边界单点相切，需人工复核`,
          );
        }
        continue;
      }

      // 几何相交时间区间与该版本各有效窗口求交，收集全部生效子时段。
      const geomFrom = schedule.timeAt(seg.index, hit.tEntry);
      const geomUntil = schedule.timeAt(seg.index, hit.tExit);
      for (const [wFrom, wUntil] of version.windows) {
        const fromMs = Math.max(geomFrom, wFrom);
        const untilMs = Math.min(geomUntil, wUntil);
        if (fromMs >= untilMs) continue;
        const span = hit.tExit - hit.tEntry;
        const tFrom =
          hit.tEntry + ((fromMs - geomFrom) / Math.max(geomUntil - geomFrom, 1)) * span;
        const tUntil =
          hit.tEntry + ((untilMs - geomFrom) / Math.max(geomUntil - geomFrom, 1)) * span;
        insideCandidates.push({
          segIndex: seg.index,
          fromMs,
          untilMs,
          tFrom,
          tUntil,
          notice: version.notice,
          tEntry: hit.tEntry,
          tExit: hit.tExit,
        });
      }
    }
  }

  // 首个相交 = 时间最早的生效子时段（航段内时间线性，按航段序即时间序）。
  insideCandidates.sort((a, b) => a.fromMs - b.fromMs || a.segIndex - b.segIndex);
  const firstInside = insideCandidates[0] ?? null;

  let firstDetail: IntersectionDetail | null = null;
  let status: DecisionResult["status"];
  let basisNotices: EffectiveNotice[] = [];

  if (firstInside) {
    status = "restricted";
    // 同一时刻可能有多机构区域重叠：生效依据包含所有覆盖该时刻的版本。
    const atEntry = new Set(
      insideCandidates
        .filter((c) => c.fromMs <= firstInside.fromMs && firstInside.fromMs < c.untilMs)
        .map((c) => c.notice.notice_id),
    );
    basisNotices = insideCandidates
      .filter((c) => atEntry.has(c.notice.notice_id))
      .map((c) => c.notice)
      .filter(
        (n, i, arr) => arr.findIndex((x) => x.notice_id === n.notice_id) === i,
      );
    const seg = schedule.segments[firstInside.segIndex]!;
    const point = (t: number) => ({
      segment_index: firstInside.segIndex,
      at: iso(schedule.timeAt(firstInside.segIndex, t)),
      lon: roundPoint([seg.from[0] + (seg.to[0] - seg.from[0]) * t, 0])[0],
      lat: roundPoint([0, seg.from[1] + (seg.to[1] - seg.from[1]) * t])[1],
      t: Math.round(t * 1e9) / 1e9,
    });
    firstDetail = {
      kind: "inside",
      segment_index: firstInside.segIndex,
      enters_at: iso(firstInside.fromMs),
      exits_at: iso(firstInside.untilMs),
      entry: point(firstInside.tFrom),
      exit: point(firstInside.tUntil),
    };

    // 几何相交在本版本窗口结束后仍在继续：记录接管版本，便于复核替代关系。
    const continuation = insideCandidates.find(
      (c) =>
        c.segIndex === firstInside.segIndex &&
        c.fromMs === firstInside.untilMs &&
        c.notice.notice_id !== firstInside.notice.notice_id,
    );
    if (continuation) {
      basisNotices.push(continuation.notice);
      reviewNotes.push(
        `通告 ${firstInside.notice.notice_id} 于 ${iso(firstInside.untilMs)} 被同机构 ` +
          `${continuation.notice.notice_id}(rev ${continuation.notice.revision}) 替代，相交区域由后者接管`,
      );
    }
  } else if (tangentHits.length > 0) {
    status = "needs_review";
    tangentHits.sort((a, b) => a.at - b.at);
    const hit = tangentHits[0]!;
    const seg = schedule.segments[hit.segIndex]!;
    const point = {
      segment_index: hit.segIndex,
      at: iso(hit.at),
      lon: roundPoint([seg.from[0] + (seg.to[0] - seg.from[0]) * hit.t, 0])[0],
      lat: roundPoint([0, seg.from[1] + (seg.to[1] - seg.from[1]) * hit.t])[1],
      t: Math.round(hit.t * 1e9) / 1e9,
    };
    firstDetail = {
      kind: "boundary_tangent",
      segment_index: hit.segIndex,
      enters_at: iso(hit.at),
      exits_at: iso(hit.at),
      entry: point,
      exit: { ...point },
    };
    basisNotices = [hit.notice];
  } else {
    status = "clear";
  }

  return {
    decision_id: request.decision_id,
    status,
    evaluated_at: evaluatedAt.toISOString(),
    departure_at: departure.toISOString(),
    first_intersection: firstDetail,
    basis: basisNotices.map(toBasis),
    review_notes: reviewNotes,
    snapshot: {
      batch_refs: input.snapshotRefs.batch_refs,
      notice_versions: versions.map((v) => ({
        notice_id: v.notice.notice_id,
        issuer: v.notice.issuer,
        sequence: v.notice.sequence,
        revision: v.notice.revision,
        status: v.notice.status,
      })),
    },
  };
}
