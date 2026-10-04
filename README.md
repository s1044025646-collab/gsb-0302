# 时隙 ALOHA 竞争传输与碰撞回放后端

一个**纯离散教学模型**的时隙 ALOHA 仿真后端：TypeScript + Node.js + SQLite，只提供 HTTP API 与 CLI，不打开任何网络端口传输消息、不涉及无线传播、编码调制或真实设备控制。

## 模型说明（重要）

- 这是**理想时隙模型**：时间被切成等长时隙，所有传输恰好持续一个时隙。
- 每个时隙开始先纳入该时隙到达的消息；每站只允许**队首**参与竞争。
- 每个时隙内，按**站点编号升序**对每个非空站各抽一次随机数；随机数 `< 发送概率` 才尝试发送。**空站不抽样**。
- 所有站的决定全部形成后**统一裁决**：恰好一个站尝试 → 成功；两个或更多 → 全部碰撞；无人尝试 → 空闲。前一站的结果不会影响后一站本时隙的决定。
- 成功才移除队首；碰撞与未尝试均保留在队首。失败消息下一时隙仍用**相同固定概率**，无额外退避算法。
- **未成功的消息不等于丢失**，它们仍在队列中等待；本模型**不承诺有限步内必定发送完**（例如两站 p=1 会永远碰撞）。
- 延迟定义：`成功时隙 - 到达时隙 + 1`。等待中的消息单独列出，不混入已成功消息的延迟均值。

## 确定性保证

- 随机发生器：mulberry32（算法版本 `mulberry32-v1`），固定 32 位种子，记录 `state` 与累计抽样数 `draws`，不使用系统时间或任何外部随机源。
- 抽样消耗顺序固定：时隙内按站点编号升序、仅非空站各抽一次。
- 站点列表按 id 升序、到达表按 `(arrivalSlot, stationId, messageId)` 规范化；输入列表顺序不同会产生**同一个规范模型**与同一条随机序列。
- 参数固定后，单步推进、批量推进、保存后重启继续，得到完全相同的事件序列（有自动化测试覆盖）。

## 环境要求

- Windows 本地，Node.js ≥ 22（使用内置 `node:sqlite`，无需 Docker / WSL / 外部服务 / 原生编译）。
- 注意：`node:sqlite` 目前仍是 Node 的实验特性，启动时会打印 `ExperimentalWarning`，不影响功能。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install      # 安装 devDependencies（typescript、@types/node）
npm run build    # 编译到 dist/
npm test         # 构建并运行全部测试（node:test）
npm start        # 启动 HTTP API（默认端口 0 = 自动选择空闲端口）
npm run demo     # 运行三个固定种子演示场景（使用临时数据目录）
```

数据目录默认为项目内 `./data`，可用环境变量 `ALOHA_DATA_DIR` 覆盖；端口可用 `node dist/src/cli.js serve --port 8080` 或 `PORT` 环境变量指定。

## CLI 用法

```
node dist/src/cli.js create-model '{"seed":7,"stations":[{"id":"A","probability":1}],"arrivals":[{"stationId":"A","messageId":"m1","arrivalSlot":0}],"maxSlots":100}'
node dist/src/cli.js import-arrivals <modelId> '{"arrivals":[...]}'   # 模型被运行使用后拒绝
node dist/src/cli.js create-run <modelId>
node dist/src/cli.js step <runId> 10        # 推进 10 个时隙（默认 1）
node dist/src/cli.js slot <runId> 0         # 查看指定时隙事件
node dist/src/cli.js stats <runId>          # 统计
node dist/src/cli.js history <runId>        # 完整事件历史
node dist/src/cli.js export <runId> out.json
node dist/src/cli.js list-models / list-runs / run <runId>
```

JSON 参数也可以写 `@文件路径` 从文件读取。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/models` | 创建模型（站点、概率、种子、到达表、限制） |
| GET | `/models` `/models/:id` | 列出 / 查看模型 |
| POST | `/models/:id/arrivals` | 导入到达表（模型已有运行后返回 `E_MODEL_FROZEN`） |
| POST | `/runs` | 创建运行 `{ "modelId": "..." }` |
| GET | `/runs` `/runs/:id` | 列出 / 查看运行状态 |
| POST | `/runs/:id/step` | 推进 `{ "count": n }`（默认 1） |
| GET | `/runs/:id/slots/:n` | 查看指定时隙事件 |
| GET | `/runs/:id/stats` | 统计（空闲/碰撞/成功、延迟、待发列表） |
| GET | `/runs/:id/history` | 完整事件历史 |
| GET | `/runs/:id/export` | 导出模型 + 运行 + 事件 + 统计的完整 JSON |

所有错误返回 `{ "error": { "code": "...", "message": "..." } }`。

## 错误码

- `E_VALIDATION` 通用参数错误；`E_DUP_STATION` 重复站点；`E_DUP_MESSAGE` 重复消息
- `E_UNKNOWN_STATION` 到达表引用不存在的站点
- `E_NEGATIVE_TIME` 负时间；`E_NON_INTEGER_SLOT` 非整数时隙/步数
- `E_BAD_PROBABILITY` 概率不在 [0,1]；`E_BAD_SEED` 种子非法
- `E_MODEL_FROZEN` 模型已存在运行，禁止修改到达表/概率（换参数请新建模型与运行）
- `E_QUEUE_OVERFLOW` 单站队列超过 `maxQueuePerStation`，运行终止并保留可解释状态
- `E_BUDGET_EXHAUSTED` 达到 `maxSlots` 总时隙预算
- `E_RUN_FINISHED` 运行已结束仍尝试推进；`E_NOT_FOUND` 资源不存在

## 持久化与一致性

- SQLite（`data/aloha.db`，WAL 模式）保存：模型（含版本 `slotted-aloha-model-v1`）、运行状态、逐时隙事件。
- 每次推进的事件写入与运行状态更新在**同一事务**中提交，保证原子一致；崩溃或重启后可从上次状态继续，且结果与一次性推进完全相同。
- 每个时隙事件包含：到达消息、各站抽样明细（随机数/概率/是否尝试）、竞争站、裁决结果、成功消息与延迟、各站队列长度、随机状态摘要。

## 演示场景（`npm run demo`）

1. 单站 p=1：逐条成功，延迟恒为 1。
2. 两站 p=1：连续碰撞，无成功（消息不丢失，持续等待）。
3. 两站 p=0.3、种子 7：相同消息在较低概率下先碰撞后成功。

## 限制

- 纯教学模型：无退避算法、无捕获效应、无传播时延、无真实网络 I/O。
- 不承诺有限步内发完所有消息；达到队列/时隙限制时运行终止并保留状态供检查。
- `node:sqlite` 为 Node 实验特性，未来 Node 版本可能有 API 变动。
