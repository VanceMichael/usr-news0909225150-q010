import { test } from "node:test";
import assert from "node:assert/strict";
import {
  haversineMeters,
  pointInPolygonInterior,
  quantizePoint,
  segmentPolygonRelation,
} from "../src/domain/geometry.js";
import { buildTimeline } from "../src/domain/time.js";
import { evaluate } from "../src/domain/evaluate.js";
import { buildChains, chainTimeline } from "../src/domain/versions.js";
import type { NoticeRecord, RouteRequest } from "../src/domain/types.js";

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0],
];

test("坐标量化到 1e-7 精度", () => {
  assert.deepEqual(quantizePoint([119.123456789, 39.987654321]), [119.1234568, 39.9876543]);
});

test("haversine：赤道 1 度约为 60 海里", () => {
  const nm = haversineMeters([0, 0], [1, 0]) / 1852;
  assert.ok(Math.abs(nm - 60) < 0.1, `got ${nm}`);
});

test("穿越矩形：interior 且给出入边/出边比例", () => {
  const r = segmentPolygonRelation([0, 0.5], [2, 0.5], rect(0.5, 0, 1.5, 1));
  assert.equal(r.relation, "interior");
  assert.ok(Math.abs(r.firstAlong - 0.25) < 1e-9);
  assert.ok(Math.abs(r.lastAlong - 0.75) < 1e-9);
});

test("顶点相切：boundary", () => {
  // 直线 y=-x 仅穿过矩形顶点 (0,0)，相邻两边在航段同侧。
  const r = segmentPolygonRelation([-2, 2], [2, -2], rect(0, 0, 1, 1));
  assert.equal(r.relation, "boundary");
});

test("沿边滑行：boundary", () => {
  const r = segmentPolygonRelation([0.2, 0], [0.8, 0], rect(0, 0, 1, 1));
  assert.equal(r.relation, "boundary");
});

test("端点落在边界：boundary（不侵入）", () => {
  const r = segmentPolygonRelation([0, 0.5], [0.5, 0.5], rect(0.5, 0, 1.5, 1));
  assert.equal(r.relation, "boundary");
});

test("完全在外：none", () => {
  const r = segmentPolygonRelation([5, 5], [6, 6], rect(0, 0, 1, 1));
  assert.equal(r.relation, "none");
});

test("点在内部判定不含边界", () => {
  const poly = rect(0, 0, 1, 1);
  assert.equal(pointInPolygonInterior([0.5, 0.5], poly), true);
  assert.equal(pointInPolygonInterior([0, 0.5], poly), false);
});

test("航段时间线：30 节航速赤道 1 度约 2 小时（60.04 海里）", () => {
  const tl = buildTimeline([[0, 0], [1, 0]], Date.parse("2026-09-20T22:00:00Z"), 30);
  assert.ok(Math.abs(tl[0]!.durationMs - 2 * 3_600_000) < 10_000);
});

function notice(partial: Partial<NoticeRecord> & Pick<NoticeRecord, "noticeId" | "sequence" | "revision" | "replaces" | "validFrom" | "validUntil" | "polygon">): NoticeRecord {
  return {
    issuer: "AUTH-X",
    status: "active",
    publishedAt: "2026-09-01T00:00:00Z",
    publishOrder: partial.sequence,
    ...partial,
  };
}

test("版本链：更正自 valid_from 起替代前版（左闭右开）", () => {
  const v1 = notice({
    noticeId: "N1", sequence: 1, revision: 1, replaces: null,
    validFrom: "2026-09-01T00:00:00Z", validUntil: "2026-09-30T00:00:00Z",
    polygon: rect(0, 0, 10, 10),
  });
  const v2 = notice({
    noticeId: "N2", sequence: 2, revision: 2, replaces: "N1",
    validFrom: "2026-09-10T00:00:00Z", validUntil: "2026-09-30T00:00:00Z",
    polygon: rect(0, 0, 10, 10),
  });
  const chains = buildChains([v1, v2]);
  const tl = chainTimeline(chains[0]!, Date.parse("2026-09-01T00:00:00Z"), Date.parse("2026-09-30T00:00:00Z"));
  assert.equal(tl.active.length, 2);
  assert.equal(tl.active[0]!.notice.noticeId, "N1");
  assert.equal(tl.active[0]!.endMs, Date.parse("2026-09-10T00:00:00Z"));
  assert.equal(tl.active[1]!.notice.noticeId, "N2");
  assert.equal(tl.active[1]!.startMs, Date.parse("2026-09-10T00:00:00Z"));
});

test("撤销版本终止整条链，撤销时刻后无管控区间", () => {
  const v1 = notice({
    noticeId: "N1", sequence: 1, revision: 1, replaces: null,
    validFrom: "2026-09-01T00:00:00Z", validUntil: "2026-09-30T00:00:00Z",
    polygon: rect(0, 0, 10, 10),
  });
  const cancel = notice({
    noticeId: "N2", sequence: 2, revision: 2, replaces: "N1", status: "revoked",
    validFrom: "2026-09-10T00:00:00Z", validUntil: "2026-09-30T00:00:00Z",
    polygon: rect(0, 0, 10, 10),
  });
  const chains = buildChains([v1, cancel]);
  const tl = chainTimeline(chains[0]!, Date.parse("2026-09-01T00:00:00Z"), Date.parse("2026-09-30T00:00:00Z"));
  assert.equal(tl.active.length, 1);
  assert.equal(tl.active[0]!.notice.noticeId, "N1");
  assert.equal(tl.active[0]!.endMs, Date.parse("2026-09-10T00:00:00Z"));
  assert.equal(tl.covered.length, 2); // 撤销版本仍保留在依据中（status=revoked）
});

test("判定：跨午夜窗口内 restricted，首个相交给出时刻与依据", () => {
  const n = notice({
    noticeId: "N1", sequence: 1, revision: 1, replaces: null,
    validFrom: "2026-09-20T23:00:00Z", validUntil: "2026-09-21T01:00:00Z",
    polygon: rect(0.7, -0.1, 1.3, 0.1),
  });
  const request: RouteRequest = {
    decisionId: "D", idempotencyKey: "k",
    departureAt: "2026-09-20T22:00:00Z", speedKnots: 30,
    route: [[0, 0], [2, 0]],
  };
  const result = evaluate({
    request, snapshotNotices: [n], snapshotMaxPublishOrder: 1,
    evaluatedAt: "2026-09-18T00:00:00Z",
  });
  assert.equal(result.status, "restricted");
  assert.equal(result.firstIntersection!.noticeId, "N1");
  // 赤道 1 度 ≈ 60.04 海里：进入约 23:24（当天），离开约 00:36（次日 UTC，跨午夜）。
  const enter = Date.parse(result.firstIntersection!.enterAt);
  const exit = Date.parse(result.firstIntersection!.exitAt);
  assert.ok(Math.abs(enter - Date.parse("2026-09-20T23:24:00Z")) < 15_000);
  assert.ok(Math.abs(exit - Date.parse("2026-09-21T00:36:00Z")) < 15_000);
});

test("判定：仅顶点相切 => needs_review", () => {
  const n = notice({
    noticeId: "N1", sequence: 1, revision: 1, replaces: null,
    validFrom: "2026-09-01T00:00:00Z", validUntil: "2026-09-30T00:00:00Z",
    polygon: rect(0.5, 0.5, 1.5, 1.5),
  });
  const request: RouteRequest = {
    decisionId: "D", idempotencyKey: "k",
    departureAt: "2026-09-20T00:00:00Z", speedKnots: 30,
    route: [[0.5, 3], [0.5, -1]],
  };
  const result = evaluate({
    request, snapshotNotices: [n], snapshotMaxPublishOrder: 1,
    evaluatedAt: "2026-09-18T00:00:00Z",
  });
  assert.equal(result.status, "needs_review");
  assert.match(result.reviewReasons[0]!, /边界相切/);
});

test("判定：无通告 => clear 且可复现空快照", () => {
  const request: RouteRequest = {
    decisionId: "D", idempotencyKey: "k",
    departureAt: "2026-09-20T00:00:00Z", speedKnots: 30,
    route: [[0, 0], [1, 0]],
  };
  const result = evaluate({
    request, snapshotNotices: [], snapshotMaxPublishOrder: null,
    evaluatedAt: "2026-09-18T00:00:00Z",
  });
  assert.equal(result.status, "clear");
  assert.deepEqual(result.snapshotNoticeIds, []);
});
