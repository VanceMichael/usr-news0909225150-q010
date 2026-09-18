// 用仓库 fixtures 端到端验证“更正替代原通告”：
// 船 05:30 以 12 节东行；N-10 自 06:00 起被 N-10-R2（更小矩形）替代，
// 船 06:16 才到原 N-10 边界，故首个相交依据必须是更正版 N-10-R2，而非原通告。
import { readFile } from "node:fs/promises";
import { migrate, publishNotice, createDecision } from "../dist/src/service/decision.service.js";
import { parseNoticeInput, parseRouteRequest } from "../dist/src/domain/validation.js";
import { pool } from "../dist/src/db/pool.js";

const load = async (path) => JSON.parse(await readFile(path, "utf8"));

await migrate();
await pool.query(
  "truncate decisions, decision_snapshot_notices, notices, test_gates restart identity cascade",
);

for (const item of await load("fixtures/notices.json")) {
  await publishNotice(parseNoticeInput(item));
}
const request = parseRouteRequest(await load("fixtures/route.json"));
const { inserted, stored } = await createDecision(request);

if (!inserted) throw new Error("fixture 判定应首次插入");
if (stored.result.status !== "restricted") {
  throw new Error(`期望 restricted，实际 ${stored.result.status}`);
}
if (stored.result.firstIntersection.noticeId !== "N-10-R2") {
  throw new Error(`首个相交依据应为更正版 N-10-R2，实际 ${stored.result.firstIntersection.noticeId}`);
}
const basisIds = stored.result.effectiveNotices.map((n) => n.noticeId);
if (!basisIds.includes("N-10") || !basisIds.includes("N-10-R2")) {
  throw new Error(`生效依据应同时展示原通告与更正：${JSON.stringify(basisIds)}`);
}
// 原通告管辖窗在更正 valid_from（06:00）截止；首个相交时刻晚于 06:00。
if (Date.parse(stored.result.firstIntersection.enterAt) <= Date.parse("2026-09-05T22:00:00Z")) {
  throw new Error("相交时刻异常（应在更正生效之后，UTC 22:00 = 北京 06:00）");
}
console.log(
  `fixture 冒烟通过：status=${stored.result.status}，首个相交航段=${stored.result.firstIntersection.segmentIndex}，` +
  `依据=${stored.result.firstIntersection.noticeId}，进入=${stored.result.firstIntersection.enterAt}`,
);
await pool.end();
