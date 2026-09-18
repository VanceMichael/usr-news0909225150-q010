/**
 * 开发用 seed：将仓库 fixtures/notices.json 作为一个发布批次写入。
 * 仅当库中不存在该批次时执行，可重复运行。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Db } from "../db.js";
import type { BatchInput, NoticeInput } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const notices = JSON.parse(
  readFileSync(join(here, "..", "..", "fixtures", "notices.json"), "utf8"),
) as NoticeInput[];

const batch: BatchInput = {
  batch_ref: "seed-fixtures",
  ops: notices.map((notice) => ({ op: "publish" as const, notice })),
};

const db = new Db();
try {
  await db.migrate();
  const exists = await db.pool.query(
    "SELECT 1 FROM notice_batches WHERE batch_ref = $1",
    ["seed-fixtures"],
  );
  if (exists.rows.length > 0) {
    console.log("seed 批次已存在，跳过");
  } else {
    await db.publishBatch(batch);
    console.log(`已写入 seed 批次 seed-fixtures（${notices.length} 份通告）`);
  }
} finally {
  await db.close();
}
