// 端到端：服务进程重启后按判定 ID 复现结论（真实进程级，非库内重放）。
// 用法：node scripts/restart-check.mjs <baseUrl 的端口由 PORT 环境变量指定>
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const port = process.env.PORT ?? "18080";
const baseUrl = `http://127.0.0.1:${port}`;

async function waitHealthy(deadlineMs = 15_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("服务未在规定时间内就绪");
}

function startServer() {
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    env: { ...process.env, PORT: port },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

async function stopServer(child) {
  await new Promise((resolve) => {
    child.on("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000).unref();
  });
}

const post = async (path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const get = async (path) => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
};

async function main() {
  const decisionId = `D-RESTART-${Date.now()}`;
  const idem = `idem-restart-${Date.now()}`;

  // 第一次启动：发布通告并做判定。
  let server = startServer();
  await waitHealthy();
  const pub = await post("/v1/admin/notices", {
    notice_id: `N-RESTART-${Date.now()}`,
    issuer: "AUTH-R",
    sequence: Date.now() % 1_000_000,
    revision: 1,
    replaces: null,
    valid_from: "2026-09-01T00:00:00Z",
    valid_until: "2026-12-31T00:00:00Z",
    polygon: [[0.7, -0.1], [1.3, -0.1], [1.3, 0.1], [0.7, 0.1], [0.7, -0.1]],
  });
  if (pub.status !== 201) throw new Error(`发布失败: ${JSON.stringify(pub.body)}`);

  const payload = {
    decision_id: decisionId,
    idempotency_key: idem,
    departure_at: "2026-09-20T00:00:00Z",
    speed_knots: 30,
    route: [[0, 0], [2, 0]],
  };
  const first = await post("/v1/decisions", payload);
  if (first.status !== 200 || first.body.decision.status !== "restricted") {
    throw new Error(`首次判定异常: ${JSON.stringify(first.body)}`);
  }
  const beforeRestart = JSON.stringify(first.body.decision);

  // 杀掉服务进程（数据库仍在），再重新启动。
  await stopServer(server);
  server = startServer();
  await waitHealthy();

  // 按判定 ID 取回：结论与冻结快照完全一致，basis_current=true。
  const fetched = await get(`/v1/decisions/${decisionId}`);
  if (fetched.status !== 200) throw new Error(`重启后读取失败: ${fetched.status}`);
  if (fetched.body.basis_current !== true) throw new Error("依据应仍为当前版本");
  if (JSON.stringify(fetched.body.decision) !== beforeRestart) {
    throw new Error("重启后结论与冻结快照不一致");
  }
  if (!fetched.body.decision.snapshot_notices?.[0]?.notice_id) {
    throw new Error("行内冻结快照缺失，无法复现当时通告集合");
  }

  // 重启后重复提交同一请求：仍只返回既有那一份结果。
  const replay = await post("/v1/decisions", payload);
  if (replay.status !== 200 || replay.body.inserted !== false) {
    throw new Error(`重启后重复提交应幂等: ${JSON.stringify(replay.body)}`);
  }

  await stopServer(server);
  console.log("重启恢复验收通过");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
