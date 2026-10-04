import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as netCreateServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { AppError, ErrorCode } from './errors.js';
import { normalizeSlot } from './normalize.js';
import { Service } from './service.js';

interface Route {
  method: string;
  pattern: RegExp;
  handle: (svc: Service, params: Record<string, string>, body: unknown, query: URLSearchParams) => unknown;
}

const routes: Route[] = [
  { method: 'POST', pattern: /^\/api\/models$/, handle: (s, _p, b) => s.createModel(b as never) },
  { method: 'GET', pattern: /^\/api\/models$/, handle: (s) => s.store.listModels() },
  { method: 'GET', pattern: /^\/api\/models\/(?<id>[^/]+)$/, handle: (s, p) => s.store.getModelConfig(p.id!) },
  {
    method: 'PUT',
    pattern: /^\/api\/models\/(?<id>[^/]+)\/arrivals$/,
    handle: (s, p, b) => ({ imported: s.importArrivals(p.id!, (b as { arrivals?: unknown })?.arrivals ?? b) }),
  },
  { method: 'POST', pattern: /^\/api\/models\/(?<id>[^/]+)\/runs$/, handle: (s, p) => s.createRun(p.id!) },
  { method: 'GET', pattern: /^\/api\/runs$/, handle: (s, _p, _b, q) => s.store.listRuns(q.get('modelId') ?? undefined) },
  {
    method: 'POST',
    pattern: /^\/api\/runs\/(?<id>[^/]+)\/advance$/,
    handle: (s, p, b) => {
      const steps = readSteps((b as { steps?: unknown })?.steps ?? 1);
      return { events: s.store.advanceRun(p.id!, steps) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/runs\/(?<id>[^/]+)\/slots\/(?<slot>\d+)$/,
    handle: (s, p) => s.store.getEvent(p.id!, normalizeSlot(p.slot, 'slot')),
  },
  { method: 'GET', pattern: /^\/api\/runs\/(?<id>[^/]+)\/stats$/, handle: (s, p) => s.store.stats(p.id!) },
  { method: 'GET', pattern: /^\/api\/runs\/(?<id>[^/]+)\/history$/, handle: (s, p) => ({ events: s.store.getHistory(p.id!) }) },
  { method: 'GET', pattern: /^\/api\/runs\/(?<id>[^/]+)\/export$/, handle: (s, p) => s.store.exportRun(p.id!) },
];

function readSteps(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new AppError(ErrorCode.INVALID_ARGUMENT, 'steps 必须是正整数', { steps: raw });
  }
  if (n > 1_000_000) throw new AppError(ErrorCode.INVALID_ARGUMENT, 'steps 过大（上限 1,000,000）', { steps: n });
  return n;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(ErrorCode.INVALID_JSON, '请求体不是合法 JSON');
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

export function buildApp(db: DatabaseSync): Server {
  const svc = new Service(db);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/health') return send(res, 200, { ok: true });
      let body: unknown = {};
      if (req.method === 'POST' || req.method === 'PUT') body = await readJson(req);
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        const result = route.handle(svc, match.groups ?? {}, body, url.searchParams);
        return send(res, 200, result);
      }
      return send(res, 404, { error: { code: ErrorCode.NOT_FOUND, message: `无此路由: ${req.method} ${url.pathname}` } });
    } catch (err) {
      if (err instanceof AppError) {
        return send(res, 400, { error: { code: err.code, message: err.message, details: err.details ?? null } });
      }
      return send(res, 500, {
        error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
      });
    }
  });
}

/** 返回一个保证空闲的端口。 */
export function getFreePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const srv = netCreateServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolveP(port));
    });
  });
}

export async function startServer(db: DatabaseSync, requestedPort?: number): Promise<{ server: Server; port: number }> {
  const port = requestedPort ?? (await getFreePort());
  const server = buildApp(db);
  await new Promise<void>((resolveP, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolveP());
  });
  return { server, port: (server.address() as AddressInfo).port };
}
