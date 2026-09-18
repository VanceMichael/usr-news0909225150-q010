import type { IncomingMessage, ServerResponse } from "node:http";
import {
  armGate,
  createDecision,
  gateArrivals,
  getDecision,
  publishNotice,
  releaseGate,
  ConflictError,
} from "../service/decision.service.js";
import { ValidationError, parseNoticeInput, parseRouteRequest } from "../domain/validation.js";
import type { NoticeRecord } from "../domain/types.js";
import { presentDecision, presentReassessment } from "./present.js";

const testGatesEnabled = process.env.ENABLE_TEST_GATES === "1";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("请求体不是合法 JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof ValidationError) {
    send(res, 400, { error: { code: "validation_error", message: err.message } });
    return;
  }
  if (err instanceof ConflictError) {
    send(res, 409, { error: { code: "conflict", message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  send(res, 500, { error: { code: "internal_error", message } });
}

function publicNotice(n: NoticeRecord) {
  return {
    notice_id: n.noticeId,
    issuer: n.issuer,
    sequence: n.sequence,
    revision: n.revision,
    replaces: n.replaces,
    valid_from: n.validFrom,
    valid_until: n.validUntil,
    polygon: n.polygon,
    status: n.status,
    published_at: n.publishedAt,
    publish_order: n.publishOrder,
  };
}

/** 纯后端 JSON API；无任何静态资源/页面。 */
export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "";

  try {
    if (method === "GET" && path === "/healthz") {
      send(res, 200, { status: "ok" });
      return;
    }

    if (method === "POST" && path === "/v1/admin/notices") {
      const input = parseNoticeInput(await readJson(req));
      const notice = await publishNotice(input);
      send(res, 201, { notice: publicNotice(notice) });
      return;
    }

    if (method === "POST" && path === "/v1/decisions") {
      const request = parseRouteRequest(await readJson(req));
      const outcome = await createDecision(request);
      send(res, 200, {
        inserted: outcome.inserted,
        basis_current: true,
        decision: presentDecision(outcome.stored.result),
      });
      return;
    }

    const decisionMatch = /^\/v1\/decisions\/([^/]+)$/.exec(path);
    if (method === "GET" && decisionMatch) {
      const view = await getDecision(decodeURIComponent(decisionMatch[1]!));
      if (!view) {
        send(res, 404, { error: { code: "not_found", message: "判定不存在" } });
        return;
      }
      send(res, 200, {
        decision: presentDecision(view.decision),
        basis_current: view.basisCurrent,
        reassessment: view.reassessment ? presentReassessment(view.reassessment) : null,
      });
      return;
    }

    // 确定性并发测试门闩（仅 ENABLE_TEST_GATES=1 时存在）。
    if (testGatesEnabled) {
      const armMatch = /^\/v1\/_test\/gates\/([^/]+)$/.exec(path);
      if (method === "POST" && armMatch && !path.endsWith("/release")) {
        const body = (await readJson(req)) as { fail?: boolean };
        await armGate(decodeURIComponent(armMatch[1]!), { fail: body.fail === true });
        send(res, 200, { armed: true });
        return;
      }
      const releaseMatch = /^\/v1\/_test\/gates\/([^/]+)\/release$/.exec(path);
      if (method === "POST" && releaseMatch) {
        await releaseGate(decodeURIComponent(releaseMatch[1]!));
        send(res, 200, { released: true });
        return;
      }
      const arrivalsMatch = /^\/v1\/_test\/gates\/([^/]+)\/arrivals$/.exec(path);
      if (method === "GET" && arrivalsMatch) {
        const arrivals = await gateArrivals(decodeURIComponent(arrivalsMatch[1]!));
        send(res, 200, { arrivals });
        return;
      }
    }

    send(res, 404, { error: { code: "not_found", message: "未知路径" }});
  } catch (err) {
    sendError(res, err);
  }
}
