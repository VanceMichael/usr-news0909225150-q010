import { Db } from "./db.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const db = new Db();
  await db.migrate();
  const server = createApp({ db });

  const stop = async (signal: string) => {
    console.log(`收到 ${signal}，开始关闭…`);
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));

  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`禁入判定服务已启动，端口 ${port}`);
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
