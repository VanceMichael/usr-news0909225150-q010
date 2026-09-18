import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ajv2020 as Ajv2020Class, ErrorObject } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import type { DecisionRequest } from "./types.js";

// ajv/ajv-formats 为 CJS 包，NodeNext 下默认导入的类型会退化为
// 模块命名空间，这里用 createRequire 取得真实导出并显式标注类型。
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default as typeof Ajv2020Class;
const addFormats = require("ajv-formats") as unknown as FormatsPlugin;

const here = dirname(fileURLToPath(import.meta.url));
const schemaPathCandidates = [
  join(here, "..", "contracts", "route-check.schema.json"),
  join(here, "..", "..", "contracts", "route-check.schema.json"),
];

let schema: { properties: Record<string, unknown> } | null = null;
for (const p of schemaPathCandidates) {
  try {
    schema = JSON.parse(readFileSync(p, "utf8"));
    break;
  } catch { /* next */ }
}
if (!schema) throw new Error("找不到 contracts/route-check.schema.json");

const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);

// 仓库契约只给了框架，这里补全航线点的形状约束：
// [经度, 纬度] 二元数组、合法经纬度范围。
const validate = ajv.compile({
  ...schema,
  properties: {
    ...schema.properties,
    route: {
      type: "array",
      minItems: 2,
      items: {
        type: "array",
        minItems: 2,
        maxItems: 2,
        prefixItems: [
          { type: "number", minimum: -180, maximum: 180 },
          { type: "number", minimum: -90, maximum: 90 },
        ],
        items: false,
      },
    },
  },
});

export function validateDecisionRequest(body: unknown): DecisionRequest {
  if (!validate(body)) {
    const detail = (validate.errors ?? [])
      .map((e: ErrorObject) => `${e.instancePath || "/"} ${e.message ?? ""}`)
      .join("; ");
    throw new ValidationError(`请求不符合契约：${detail}`);
  }
  const req = body as DecisionRequest;
  const from = Date.parse(req.departure_at);
  if (Number.isNaN(from)) throw new ValidationError("departure_at 不是合法时间");
  if (!(req.speed_knots > 0)) throw new ValidationError("speed_knots 必须为正数");
  return req;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
