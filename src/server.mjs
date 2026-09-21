import http from "node:http";
import { createApp } from "./app.mjs";

/**
 * 兼容旧测试的无状态工厂仍保留；默认装配使用持久化应用。
 * 测试可传入 { dataDir, clock }。
 */
export function createServer(options = {}) {
  const app = createApp(options);
  const server = http.createServer((request, response) => {
    if (request.url === "/health" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    app.route(request).then((result) => {
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    });
  });
  server.on("close", () => app.engine.stop());
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "8000", 10);
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`太空实验材料链服务已启动：http://127.0.0.1:${port}`);
  });
}
