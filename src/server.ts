import { createServer } from "node:http";
import { handle } from "./http/app.js";
import { migrate } from "./service/decision.service.js";
import { closePool } from "./db/pool.js";

const port = Number(process.env.PORT ?? 8080);

const server = createServer((req, res) => {
  void handle(req, res);
});

async function main(): Promise<void> {
  await migrate();
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`禁入判定服务已监听 :${port}`);
}

const shutdown = async (): Promise<void> => {
  server.close();
  await closePool();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

main().catch((err) => {
  console.error("启动失败", err);
  process.exit(1);
});
