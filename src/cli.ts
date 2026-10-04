#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from './db.js';
import { AppError, ErrorCode } from './errors.js';
import { Service } from './service.js';
import { startServer } from './server.js';
import { runDemos } from './demo.js';

const DATA_DIR = process.env.ALOHA_DATA_DIR ?? 'data';
const DB_PATH = process.env.ALOHA_DB ?? resolve(DATA_DIR, 'aloha.sqlite');

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

function readJsonParam(inline?: string, file?: string): unknown {
  if (file) return JSON.parse(readFileSync(resolve(file), 'utf8'));
  if (inline) return JSON.parse(inline);
  return {};
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const db = openDatabase(DB_PATH);
  const svc = new Service(db);

  try {
    switch (command) {
      case 'serve': {
        const portRaw = arg('--port');
        const port = portRaw ? Number(portRaw) : undefined;
        const { port: actual } = await startServer(db, port);
        process.stdout.write(`时隙 ALOHA 后端已启动: http://127.0.0.1:${actual}  (数据: ${DB_PATH})\n`);
        break;
      }
      case 'model': {
        switch (arg('--op', 'create')) {
          case 'create': {
            const body = readJsonParam(arg('--json'), arg('--file'));
            out(svc.createModel(body as never));
            break;
          }
          case 'list':
            out(svc.store.listModels());
            break;
          case 'get':
            out(svc.store.getModelConfig(requireId('--model-id')));
            break;
        }
        break;
      }
      case 'arrivals': {
        const modelId = requireId('--model-id');
        const body = readJsonParam(arg('--json'), arg('--file'));
        const arrivals = (body as { arrivals?: unknown })?.arrivals ?? body;
        out({ imported: svc.importArrivals(modelId, arrivals) });
        break;
      }
      case 'run': {
        const modelId = requireId('--model-id');
        out(svc.createRun(modelId));
        break;
      }
      case 'advance': {
        const runId = requireId('--run-id');
        const steps = Number(arg('--steps', '1'));
        out({ events: svc.store.advanceRun(runId, steps) });
        break;
      }
      case 'slot':
        out(svc.store.getEvent(requireId('--run-id'), Number(requireId('--slot'))));
        break;
      case 'stats':
        out(svc.store.stats(requireId('--run-id')));
        break;
      case 'history':
        out({ events: svc.store.getHistory(requireId('--run-id')) });
        break;
      case 'export': {
        const path = arg('--out');
        const data = svc.store.exportRun(requireId('--run-id'));
        if (path) {
          writeFileSync(resolve(path), JSON.stringify(data, null, 2));
          out({ exportedTo: path });
        } else {
          out(data);
        }
        break;
      }
      case 'demo': {
        out(runDemos(db));
        break;
      }
      default:
        printUsage();
    }
  } catch (err) {
    if (err instanceof AppError) {
      process.stderr.write(`错误 [${err.code}]: ${err.message}\n`);
      if (err.details !== undefined) process.stderr.write(JSON.stringify(err.details) + '\n');
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

function requireId(flag: string): string {
  const value = arg(flag);
  if (!value) throw new AppError(ErrorCode.INVALID_ARGUMENT, `缺少参数 ${flag}`);
  return value;
}

function printUsage(): void {
  process.stdout.write(`时隙 ALOHA 后端 CLI

用法:
  aloha serve [--port 端口]                启动 HTTP API（默认自动选择空闲端口）
  aloha model create --file f.json         建模（也可用 --json '{...}'）
  aloha model list
  aloha model get --model-id ID
  aloha arrivals --model-id ID --file a.json   导入到达表（运行创建前）
  aloha run --model-id ID                  创建运行（锁定模型）
  aloha advance --run-id ID [--steps N]    推进 N 个时隙
  aloha slot --run-id ID --slot N          查看指定时隙
  aloha stats --run-id ID                  统计
  aloha history --run-id ID                历史事件
  aloha export --run-id ID [--out f.json]  JSON 导出
  aloha demo                               运行固定种子教学演示

环境变量: ALOHA_DATA_DIR(默认 data), ALOHA_DB(默认 data/aloha.sqlite)
`);
}

main().catch((err) => {
  process.stderr.write((err as Error).stack ?? String(err));
  process.exit(1);
});
