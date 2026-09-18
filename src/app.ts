/**
 * 纯后端 HTTP 服务（node:http，无任何前端资源）。
 *
 * 路由：
 *   GET  /healthz
 *   POST /admin/batches           原子发布/撤销通告
 *   POST /decisions               提交判定（幂等）
 *   GET  /decisions/:id           取回冻结结论（重启可复现）
 *   POST /decisions/:id/recheck   复检是否 stale
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Db, ConflictError, FaultInjectedError } from "./db.js";
import { validateDecisionRequest, ValidationError } from "./validation.js";
import { validateBatch } from "./batchValidation.js";

export interface AppDeps {
  db: Db;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_048_576) throw new ValidationError("请求体超过 1MiB");
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    throw new ValidationError("请求体不是合法 JSON");
  }
}

export function createApp(deps: AppDeps): Server {
  const { db } = deps;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "";

      if (method === "GET" && url.pathname === "/healthz") {
        send(res, 200, { status: "ok" });
        return;
      }

      if (method === "POST" && url.pathname === "/admin/batches") {
        const body = validateBatch(await readJson(req));
        const { batchId } = await db.publishBatch(body);
        send(res, 201, { batch_ref: body.batch_ref, batch_id: batchId, ops: body.ops.length });
        return;
      }

      const decisionMatch = url.pathname.match(/^\/decisions\/([^/]+)$/);
      if (method === "POST" && url.pathname === "/decisions") {
        const body = await readJson(req);
        const request = validateDecisionRequest(body);
        const fault = (url.searchParams.get("fault") as "abort_after_snapshot" | null) ?? null;
        const { result, reused } = await db.createDecision(request, { fault });
        send(res, reused ? 200 : 201, result);
        return;
      }

      if (method === "GET" && decisionMatch) {
        const result = await db.getDecision(decodeURIComponent(decisionMatch[1]!));
        if (!result) {
          send(res, 404, { error: "判定不存在", decision_id: decisionMatch[1] });
          return;
        }
        send(res, 200, result);
        return;
      }

      const recheckMatch = url.pathname.match(/^\/decisions\/([^/]+)\/recheck$/);
      if (method === "POST" && recheckMatch) {
        const outcome = await db.recheckDecision(decodeURIComponent(recheckMatch[1]!));
        if (!outcome) {
          send(res, 404, { error: "判定不存在", decision_id: recheckMatch[1] });
          return;
        }
        send(res, 200, { stale: outcome.stale, result: outcome.result });
        return;
      }

      send(res, 404, { error: "未找到路由" });
    } catch (err) {
      if (err instanceof ValidationError) {
        send(res, 400, { error: err.message });
      } else if (err instanceof ConflictError) {
        send(res, 409, { error: err.message });
      } else if (err instanceof FaultInjectedError) {
        send(res, 500, { error: err.message, injected: true });
      } else if (isPgError(err)) {
        // 发布中的约束冲突属于客户端可纠正错误，不当作 500。
        if (err.code === "23505") {
          send(res, 409, { error: `资源冲突：${err.constraint ?? "唯一约束"}` });
        } else if (["23503", "23514", "23502", "22P02", "22007"].includes(err.code)) {
          send(res, 400, { error: `数据约束错误：${err.message}` });
        } else {
          console.error("请求处理失败:", err);
          send(res, 500, { error: "服务内部错误" });
        }
      } else {
        console.error("请求处理失败:", err);
        send(res, 500, { error: "服务内部错误" });
      }
    }
  });

  return server;
}

interface PgErrorShape {
  code: string;
  constraint?: string;
  message: string;
}

function isPgError(err: unknown): err is PgErrorShape {
  return typeof err === "object" && err !== null && "code" in err;
}
