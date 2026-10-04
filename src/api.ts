import * as http from "node:http";
import { AddressInfo } from "node:net";
import { errorBody, httpStatusOf } from "./errors";
import { Store } from "./store";

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const data = JSON.stringify(body, null, 2);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(data);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = method === "POST" ? ((await readBody(req)) as Record<string, unknown>) : {};

      // 路由
      if (method === "GET" && parts.length === 0) {
        return send(200, { name: "slotted-aloha-backend", endpoints: [
          "POST /models", "GET /models", "GET /models/:id", "POST /models/:id/arrivals",
          "POST /runs", "GET /runs", "GET /runs/:id", "POST /runs/:id/step",
          "GET /runs/:id/slots/:n", "GET /runs/:id/stats", "GET /runs/:id/history", "GET /runs/:id/export",
        ]});
      }
      if (parts[0] === "models") {
        if (method === "POST" && parts.length === 1) return send(201, store.createModel(body));
        if (method === "GET" && parts.length === 1) return send(200, store.listModels());
        if (method === "GET" && parts.length === 2) return send(200, store.getModel(parts[1]));
        if (method === "POST" && parts.length === 3 && parts[2] === "arrivals") {
          const arrivals = (body as { arrivals?: unknown }).arrivals ?? body;
          return send(200, store.importArrivals(parts[1], arrivals));
        }
      }
      if (parts[0] === "runs") {
        if (method === "POST" && parts.length === 1) {
          return send(201, store.createRun(String((body as { modelId?: unknown }).modelId ?? "")));
        }
        if (method === "GET" && parts.length === 1) return send(200, store.listRuns());
        if (method === "GET" && parts.length === 2) return send(200, store.getRun(parts[1]));
        if (method === "POST" && parts.length === 3 && parts[2] === "step") {
          const count = (body as { count?: unknown }).count ?? 1;
          return send(200, store.step(parts[1], Number(count)));
        }
        if (method === "GET" && parts.length === 4 && parts[2] === "slots") {
          return send(200, store.getSlot(parts[1], Number(parts[3])));
        }
        if (method === "GET" && parts.length === 3 && parts[2] === "stats") return send(200, store.stats(parts[1]));
        if (method === "GET" && parts.length === 3 && parts[2] === "history") return send(200, store.history(parts[1]));
        if (method === "GET" && parts.length === 3 && parts[2] === "export") return send(200, store.exportRun(parts[1]));
      }
      send(404, { error: { code: "E_NOT_FOUND", message: `未知路由: ${method} ${url.pathname}` } });
    } catch (err) {
      send(httpStatusOf(err), errorBody(err));
    }
  });
}

/** 启动服务；port 为 0 或未指定时由系统分配空闲端口。 */
export function serve(store: Store, port: number, host = "127.0.0.1"): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = createServer(store);
    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}
