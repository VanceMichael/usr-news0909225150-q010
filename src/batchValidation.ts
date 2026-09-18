import type { BatchInput } from "./types.js";
import { COORD_DECIMALS } from "./precision.js";
import { ValidationError } from "./validation.js";

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** 校验发布批次入参，不合法时抛 ValidationError。 */
export function validateBatch(body: unknown): BatchInput {
  if (!body || typeof body !== "object") throw new ValidationError("批次必须是对象");
  const b = body as Record<string, unknown>;
  if (typeof b.batch_ref !== "string" || b.batch_ref.trim() === "") {
    throw new ValidationError("batch_ref 必须是非空字符串");
  }
  if (!Array.isArray(b.ops) || b.ops.length === 0) {
    throw new ValidationError("ops 必须是非空数组");
  }

  b.ops.forEach((op, i) => {
    if (!op || typeof op !== "object") throw new ValidationError(`ops[${i}] 不是对象`);
    const o = op as Record<string, unknown>;
    if (o.op === "revoke") {
      if (typeof o.notice_id !== "string" || o.notice_id.trim() === "") {
        throw new ValidationError(`ops[${i}] 撤销缺少 notice_id`);
      }
      return;
    }
    if (o.op !== "publish") {
      throw new ValidationError(`ops[${i}].op 只能是 publish 或 revoke`);
    }
    const n = o.notice as Record<string, unknown> | undefined;
    if (!n || typeof n !== "object") {
      throw new ValidationError(`ops[${i}] publish 缺少 notice`);
    }
    const requireStr = (key: string) => {
      if (typeof n[key] !== "string" || (n[key] as string).trim() === "") {
        throw new ValidationError(`ops[${i}].notice.${key} 必须是非空字符串`);
      }
    };
    requireStr("notice_id");
    requireStr("issuer");
    if (!Number.isInteger(n.sequence) || (n.sequence as number) < 0) {
      throw new ValidationError(`ops[${i}].notice.sequence 必须是非负整数`);
    }
    if (!Number.isInteger(n.revision) || (n.revision as number) < 1) {
      throw new ValidationError(`ops[${i}].notice.revision 必须是 >=1 的整数`);
    }
    if (n.replaces !== null && typeof n.replaces !== "string") {
      throw new ValidationError(`ops[${i}].notice.replaces 必须为 null 或字符串`);
    }
    const from = Date.parse(n.valid_from as string);
    const until = Date.parse(n.valid_until as string);
    if (Number.isNaN(from)) throw new ValidationError(`ops[${i}].notice.valid_from 时间非法`);
    if (Number.isNaN(until)) throw new ValidationError(`ops[${i}].notice.valid_until 时间非法`);
    if (until <= from) {
      throw new ValidationError(`ops[${i}].notice 有效期必须满足 valid_until > valid_from（半开区间）`);
    }
    if (!Array.isArray(n.polygon) || n.polygon.length < 4) {
      throw new ValidationError(`ops[${i}].notice.polygon 至少 4 个点`);
    }
    const poly = n.polygon as unknown[];
    poly.forEach((p, j) => {
      if (!Array.isArray(p) || p.length !== 2 || !isFiniteNumber(p[0]) || !isFiniteNumber(p[1])) {
        throw new ValidationError(`ops[${i}].notice.polygon[${j}] 必须是 [经度, 纬度]`);
      }
      if (p[0] < -180 || p[0] > 180 || p[1] < -90 || p[1] > 90) {
        throw new ValidationError(`ops[${i}].notice.polygon[${j}] 坐标越界`);
      }
    });
    const first = poly[0] as [number, number];
    const last = poly[poly.length - 1] as [number, number];
    const eps = Math.pow(10, -COORD_DECIMALS) / 2;
    if (Math.abs(first[0] - last[0]) > eps || Math.abs(first[1] - last[1]) > eps) {
      throw new ValidationError(`ops[${i}].notice.polygon 必须首尾闭合（${COORD_DECIMALS} 位小数精度）`);
    }
  });

  return body as BatchInput;
}
