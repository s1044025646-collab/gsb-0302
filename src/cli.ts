import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./store";
import { serve } from "./api";
import { runDemo } from "./demo";

function dataDir(): string {
  return process.env.ALOHA_DATA_DIR ?? path.join(process.cwd(), "data");
}

function print(x: unknown): void {
  process.stdout.write(JSON.stringify(x, null, 2) + "\n");
}

function readJsonArg(arg: string): unknown {
  if (arg.startsWith("@")) {
    return JSON.parse(fs.readFileSync(arg.slice(1), "utf8"));
  }
  return JSON.parse(arg);
}

const USAGE = `时隙 ALOHA 后端 CLI
用法: node dist/cli.js <命令> [参数]
  serve [--port N]                 启动 HTTP API（默认端口 0，即自动选择空闲端口）
  create-model '<json>'|@file      创建模型（站点、概率、种子、到达表、限制）
  import-arrivals <modelId> '<json>'|@file   导入到达表（模型被运行使用后拒绝）
  list-models                      列出模型
  create-run <modelId>             创建运行
  list-runs                        列出运行
  step <runId> [count]             推进 count 个时隙（默认 1）
  run <runId>                      查看运行状态
  slot <runId> <n>                 查看指定时隙事件
  stats <runId>                    查看统计
  history <runId>                  查看完整事件历史
  export <runId> [file]            导出 JSON（默认打印到 stdout）
  demo                             运行三个固定种子演示场景
环境变量: ALOHA_DATA_DIR 指定数据目录（默认 ./data）
`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  const store = new Store({ dataDir: dataDir() });
  try {
    switch (cmd) {
      case "serve": {
        const idx = args.indexOf("--port");
        const port = idx >= 0 ? Number(args[idx + 1]) : Number(process.env.PORT ?? 0);
        const { port: actual } = await serve(store, Number.isFinite(port) ? port : 0);
        process.stdout.write(`ALOHA API 已启动: http://127.0.0.1:${actual}\n`);
        return; // 保持进程存活
      }
      case "create-model":
        print(store.createModel(readJsonArg(args[0]) as Record<string, unknown>));
        break;
      case "import-arrivals":
        print(store.importArrivals(args[0], (readJsonArg(args[1]) as { arrivals?: unknown }).arrivals ?? readJsonArg(args[1])));
        break;
      case "list-models":
        print(store.listModels());
        break;
      case "create-run":
        print(store.createRun(args[0]));
        break;
      case "list-runs":
        print(store.listRuns());
        break;
      case "step":
        print(store.step(args[0], args[1] ? Number(args[1]) : 1));
        break;
      case "run":
        print(store.getRun(args[0]));
        break;
      case "slot":
        print(store.getSlot(args[0], Number(args[1])));
        break;
      case "stats":
        print(store.stats(args[0]));
        break;
      case "history":
        print(store.history(args[0]));
        break;
      case "export": {
        const data = store.exportRun(args[0]);
        if (args[1]) {
          fs.writeFileSync(args[1], JSON.stringify(data, null, 2), "utf8");
          process.stdout.write(`已导出到 ${args[1]}\n`);
        } else {
          print(data);
        }
        break;
      }
      case "demo": {
        const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "aloha-demo-"));
        const demoStore = new Store({ dataDir: tmp });
        try { runDemo(demoStore); } finally { demoStore.close(); }
        break;
      }
        break;
      default:
        process.stderr.write(`未知命令: ${cmd}\n\n${USAGE}`);
        process.exitCode = 2;
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

main().catch((err) => {
  const e = err as { code?: string; message?: string };
  process.stderr.write(`错误 [${e.code ?? "E_INTERNAL"}]: ${e.message ?? String(err)}\n`);
  process.exitCode = 1;
});

