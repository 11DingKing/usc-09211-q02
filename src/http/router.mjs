/**
 * 极简 JSON 路由：不引入第三方依赖。
 * 处理器返回 { status, body }；抛出 DomainError 自动转为稳定错误体。
 */
export function createJsonRouter(routes, { onError } = {}) {
  return async function handle(request) {
    const url = new URL(request.url, "http://local");
    let body;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const raw = await readBody(request);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          return json(400, {
            error: { code: "VALIDATION_FAILED", message: "请求体不是合法 JSON" },
          });
        }
      } else {
        body = {};
      }
    }
    for (const route of routes) {
      if (route.method !== request.method) continue;
      const match = matchPath(route.pattern, url.pathname);
      if (!match) continue;
      try {
        const result = await route.handler({ body, params: match, query: url.searchParams, request });
        return json(result.status ?? 200, result.body, result.headers);
      } catch (error) {
        if (onError) onError(error, { request });
        if (error && typeof error.toBody === "function") {
          const status =
            error.code === "NOT_FOUND" ? 404
            : error.code === "STAGE_BLOCKED" ? 422
            : error.code === "CONFLICT" ? 409
            : 400;
          return json(status, error.toBody(), error.headers);
        }
        return json(500, { error: { code: "INTERNAL", message: "服务内部错误" } });
      }
    }
    return json(404, { error: { code: "NOT_FOUND", message: `无此路由：${request.method} ${url.pathname}` } });
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new Error("请求体超过 1 MiB 上限"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function json(status, body, extraHeaders = {}) {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

/** 支持 "/x/:id/y" 形式的路径参数。 */
function matchPath(pattern, pathname) {
  const patternParts = pattern.split("/").filter(Boolean);
  const actualParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== actualParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i];
    const actual = decodeURIComponent(actualParts[i]);
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = actual;
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}
