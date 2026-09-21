import { Engine } from "./store/engine.mjs";
import { buildRoutes } from "./http/handlers.mjs";
import { createJsonRouter } from "./http/router.mjs";

/**
 * 应用装配：引擎（WAL + 内存态）+ 路由。
 * dataDir 默认 ./data；clock 可注入以便测试审批过期等时间语义。
 */
export function createApp(options = {}) {
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? "./data";
  const clock = options.clock ?? (() => Date.now());
  const engine = new Engine({ dataDir, clock });
  const { replayed } = engine.start();
  const routes = buildRoutes(engine, clock);
  const route = createJsonRouter(routes, {
    onError: (error) => {
      if (!(error && typeof error.toBody === "function")) console.error(error);
    },
  });
  return { engine, route, replayed };
}
