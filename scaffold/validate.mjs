import { readFile } from "node:fs/promises";

const load = async (path) => JSON.parse(await readFile(path, "utf8"));
const notices = await load("fixtures/notices.json");
const route = await load("fixtures/route.json");
const schema = await load("contracts/route-check.schema.json");
const ids = new Set(notices.map((item) => item.notice_id));
if (!notices.every((item) => item.replaces === null || ids.has(item.replaces))) throw new Error("通告替代关系不闭合");
if (route.route.length < 2 || !schema.required.includes("departure_at")) throw new Error("航线领域文件不完整");
console.log(`已校验 ${notices.length} 份通告和 ${route.route.length - 1} 个航段`);
