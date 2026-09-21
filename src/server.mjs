import http from "node:http";

export function createServer() {
  return http.createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  createServer().listen(8000, "127.0.0.1");
}
