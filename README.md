# 时隙 ALOHA 竞争传输与碰撞回放后端

纯后端的**离散教学仿真**：在共享信道上配置若干发送站、按时隙到达的消息、固定发送概率与
固定随机种子，推进有限个时隙，观察等待队列、成功传输、碰撞与时隙延迟。

- 技术栈：TypeScript + Node.js（内置 `node:sqlite`，**无第三方运行时依赖**）+ 内置 HTTP/测试框架。
- 仅提供 **HTTP API 与 CLI**，不打开网络端口传输真实消息，不实现无线传播、编码调制或设备控制。
- Windows 本地直接运行，**不需要 Docker、WSL、付费服务或外部在线 API**。
- 数据保存在项目内 `data/` 目录的 SQLite 文件中。

> 模型版本：`slotted-aloha-1.0.0`　随机算法：`mulberry32-v1`

## 模型语义（重要）

每条消息的传输恰持续一个时隙。对每个时隙 `t`，严格按以下顺序：

1. **先到达**：把到达时隙等于 `t` 的消息纳入各站队列尾部。
2. **独立决定**：按**规范化站点编号升序**，对每个**队列非空**的站抽取一次 `[0,1)` 随机数；
   当且仅当 `随机数 < 该站发送概率` 时该站尝试发送。
3. **统一裁决**：所有站的决定都形成后再判定：
   - 0 个站尝试 → `idle`（空闲）；
   - 1 个站尝试 → `success`（成功），该站队首消息被移除；
   - 2 个或更多站尝试 → `collision`（碰撞），**所有**尝试消息保留。
4. 未尝试或碰撞的消息下一时隙**仍用相同固定概率**重试，**没有退避算法**。

边界与确定性：

- 概率 `0` 恒不尝试；概率 `1` 恒尝试（抽样仍会发生，用于对齐随机序列）。
- **空站不抽样**，因此不会消耗随机数、也不改变后续随机序列。
- 随机源只来自固定种子（`mulberry32`），**不使用系统时间随机值**。
- 到达表、站点顺序、消息编号都会**规范化排序**；输入列表顺序改变不会改变同一规范模型的随机序列。
- 系统延迟定义为 `成功时隙 - 到达时隙 + 1`；仅对已成功消息求均值，等待中消息单独列出、**不混入均值**。
- **未成功的消息仍在队列中等待，不等于丢失**；模型也**不承诺在有限步内一定发完**
  （例如概率 0、或持续碰撞时）。

### 随机状态与抽样消耗

每个事件都记录 `rngBefore` 与 `rngAfter`，格式为 `mulberry32-v1:<state>:<draws>`，
相邻时隙满足 `当前 rngBefore == 上一 rngAfter`。抽样消耗顺序即时隙内站点编号升序、
跳过空队列。

## 校验与错误码

校验失败返回结构化错误（HTTP 400，CLI 以退出码 1 打印），不静默丢消息：

| 错误码 | 触发条件 |
| --- | --- |
| `EMPTY_STATIONS` | 没有配置任何站点 |
| `DUPLICATE_STATION` | 站点编号重复 |
| `DUPLICATE_MESSAGE` | 消息编号重复 |
| `UNKNOWN_STATION` | 到达消息引用了未配置的站点 |
| `INVALID_SLOT` | 时隙为负、非整数或非数字 |
| `INVALID_PROBABILITY` | 概率不在 `[0,1]` |
| `INVALID_SEED` | 种子不是 `[0, 4294967295]` 的整数 |
| `INVALID_LIMIT` | 队列/时隙预算为负或非整数 |
| `QUEUE_OVERFLOW` | 某站本时隙到达后将超过单站队列预算；**整时隙事务回滚，不纳入任何消息** |
| `RUN_LOCKED` | 模型已创建运行后试图改写到达表（换参数请新建模型/运行） |
| `RUN_FINISHED` | 已达总时隙预算仍继续推进 |
| `NOT_FOUND` / `INVALID_JSON` / `INVALID_ARGUMENT` | 资源不存在 / 请求 JSON 非法 / 参数非法 |

预算：`perStationQueueLimit` 与 `totalSlotBudget` 为 `0` 表示不限。达到时隙预算时运行置为
`finished` 并保留可解释状态。

## 环境要求

- Node.js `>= 23.6`（内置 `node:sqlite`；开发环境验证版本 v25.5.0）。
- 仅构建期需要 TypeScript 与类型定义（已在 devDependencies 中）。

## 构建、测试、启动、演示

```powershell
npm install        # 安装构建依赖
npm run build      # TypeScript 编译到 dist/
npm test           # 运行全部测试（node:test）
npm start          # 启动 HTTP API，默认自动选择空闲端口
npm run demo       # 运行固定种子教学演示（内存数据库，不污染数据）
```

可选环境变量：

- `ALOHA_DATA_DIR`：数据目录，默认 `./data`
- `ALOHA_DB`：SQLite 文件路径，默认 `data/aloha.sqlite`

## CLI 用法

```powershell
# 建模（概率可站点单独给，或用全局 probability）
node dist/src/cli.js model create --file model.json
node dist/src/cli.js model list
node dist/src/cli.js model get --model-id <ID>

# 运行创建前可替换到达表
node dist/src/cli.js arrivals --model-id <ID> --file arrivals.json

node dist/src/cli.js run --model-id <ID>                 # 创建运行（锁定模型）
node dist/src/cli.js advance --run-id <ID> --steps 5     # 推进 5 个时隙
node dist/src/cli.js slot --run-id <ID> --slot 0         # 查看指定时隙
node dist/src/cli.js stats --run-id <ID>                 # 统计
node dist/src/cli.js history --run-id <ID>               # 历史事件
node dist/src/cli.js export --run-id <ID> --out run.json # JSON 导出
node dist/src/cli.js serve --port 8080                   # 指定端口（默认选空闲端口）
```

`model.json` 示例：

```json
{
  "name": "two-station",
  "seed": 2024,
  "perStationQueueLimit": 0,
  "totalSlotBudget": 100,
  "stations": [
    { "stationId": "A", "probability": 0.5 },
    { "stationId": "B", "probability": 0.5 }
  ],
  "arrivals": [
    { "messageId": "m1", "stationId": "A", "arrivalSlot": 0 },
    { "messageId": "m2", "stationId": "B", "arrivalSlot": 0 }
  ]
}
```

也可在站点对象中省略 `probability`，改用顶层 `"probability": 0.5` 作为统一概率。

## HTTP API

服务监听 `http://127.0.0.1:<port>`，健康检查 `GET /health`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/models` | 建模（请求体同 `model.json`） |
| GET | `/api/models` | 列出模型 |
| GET | `/api/models/:id` | 查看模型（含规范化站点与到达表） |
| PUT | `/api/models/:id/arrivals` | 替换到达表（仅在尚无运行时，体为 `{ "arrivals": [...] }` 或数组） |
| POST | `/api/models/:id/runs` | 创建运行 |
| GET | `/api/runs?modelId=...` | 列出运行 |
| POST | `/api/runs/:id/advance` | 推进，体 `{ "steps": 5 }`（默认 1） |
| GET | `/api/runs/:id/slots/:slot` | 查看指定时隙事件 |
| GET | `/api/runs/:id/stats` | 统计 |
| GET | `/api/runs/:id/history` | 全部历史事件 |
| GET | `/api/runs/:id/export` | 完整 JSON 导出（模型+状态+事件+统计） |

快速试一下（PowerShell）：

```powershell
node dist/src/cli.js serve          # 记下输出端口
$b = 'http://127.0.0.1:<PORT>'
Invoke-RestMethod "$b/api/models" -Method Post -ContentType 'application/json' -Body (Get-Content model.json -Raw)
```

## 持久化与一致性

SQLite 中保存：

- `meta`：模型版本与随机算法版本；
- `models` / `arrivals`：规范化后的站点、概率、种子、预算与到达表；
- `runs`：运行及**完整状态快照**（当前时隙、各站队列、随机状态、计数器、延迟记录）；
- `events`：每个时隙的到达、抽样站、随机数、竞争站、结果、各队列长度、随机状态摘要。

每次“推进”在**单个 `BEGIN IMMEDIATE` 事务**中写入全部事件并更新状态快照；任何一步
（含队列溢出、达到预算）抛错都会整体回滚，保证状态与事件原子一致。因此可以**关闭后重启
继续推进**，结果与一次性推进完全一致（测试已覆盖）。

## 固定种子演示

`npm run demo` 运行三个确定性例子：

1. **单站概率 1**：每时隙唯一站尝试 → 连续 `success`，消息逐条发出。
2. **两站概率 1**：两站每时隙必然同时尝试 → 连续 `collision`，队列都保留。
3. **相同消息、较低概率（0.5）**：确定性地挑选第一个在时隙 0 恰好只有一站尝试的种子
   （本实现为种子 `1`）→ 时隙 0 即 `success`，展示固定随机抽样如何改变结果。

## 测试覆盖

- 概率 `0`/`1` 的手工可预测行为；到达先于裁决；失败不引入退避。
- 固定随机序列下一站成功、两站碰撞；空站不消耗随机数。
- 输入列表顺序规范化不改变随机序列。
- 重复站点/消息、负时间/非整数时隙、非法概率、未知站点、队列超限、历史锁定等校验。
- 不变量：`到达总数 = 成功 + 待发`，`空闲 + 碰撞 + 成功 = 推进步数`，延迟来自真实成功事件。
- 一次性推进 vs 分段推进 + 重启重开数据库：事件、统计、随机状态链完全一致。
- HTTP API 端到端与结构化错误码。

## 限制与假设

- 理想化时隙模型：假设完美时隙同步，无传播、捕获、信噪比、编码与真实设备因素。
- 不实现退避，失败消息始终以相同固定概率重试。
- `mulberry32` 为教学级伪随机算法，满足可复现性，不用于安全用途。
- 服务绑定本机回环地址，仅面向本地使用。
