# dsh-taskflow

DSH 全自动任务工作流插件：任务提出后由 Codex CLI 规划拆分为 Issue（带验收标准与依赖 DAG）→ 发布看板 → DSH 认领执行（串行/并行）→ Codex 只读审查决定打回/通过 → 按依赖序推进 → 最终人工验收。人工只在"提出任务"与"最终验收"介入。

## 状态

**P8.3（当前）**：自动推进协调器——`automationEnabled=true` 时按 `autoPlan`/`autoReview` 自动串联“提交 → 规划 → 执行 → 审查 → 人工窗口”，新增 `/plugins/taskflow/events` SSE 事件流与浏览器实时刷新，并在审查返工达到 `maxReviewCycles` 时进入 `WAITING_DECISION` 人工介入窗口。

已完成：

- **P0**：双端插件骨架——宿主服务（持久化运行台账）、同源 JSON 路由、输入 dock 状态卡片、模型通告段。
- **P1**：持久内核——Run 聚合、状态机、DAG 校验、幂等迁移、重启恢复。
- **P2**：Codex Planner——进程执行器、真实 JSONL 事件解析、严格输出 Schema、超时重试、规划状态流、repoRoot 白名单/规范化。
- **P2.5**：规划并发与幂等收敛——显式幂等键、planning 单飞、持久化 PLANNING 转换后才应答、重启续跑。
- **P3**：串行执行引擎——`READY → EXECUTING` 确定性认领（依赖拓扑序、一次一个）、`exec-result` 上报、失败即 `FAILED`、全部完成进入 `INTEGRATION_REVIEW`；支持 agent 驱动与自动化 Executor 双模式、重启恢复。
- **P4**：Reviewer/Rework——`INTEGRATION_REVIEW` 后经 `/plugins/taskflow/review` 触发 Codex 只读审查（无 baseSha 时使用 `codex exec review --uncommitted`，有 baseSha 时使用通用 `codex exec --cd` 审查集成 diff；模型 `gpt-5.6-sol`、推理强度 `high`、只读沙箱）；PASS → `AWAITING_HUMAN`，REVISE → `EXECUTING` 并重置返工 Issue（含下游依赖）供执行器重新认领；审查记录持久化到 Run 聚合。
- **P5**：DAG/Worktree——按 DAG 并行执行（`maxConcurrent` 配置，默认 1 保持串行兼容）；每个 Issue 在独立 Git worktree 中执行，成功后自动提交 worktree 内未提交改动、经专用 integration worktree 串行合并到集成分支 `taskflow/integration`，再清理 worktree/分支；执行/快照暴露 `workDir`、`branch` 与 `baseSha`。
- **P6**：Board/迁移——`/plugins/taskflow/board` 只读看板快照、纯函数 `buildBoard`、浏览器看板弹层（点击状态卡片打开，五列卡片随状态自动迁移）。
- **P7**：人工验收门/收口——`/plugins/taskflow/human-decision` 支持 `accept|rework`；`accept` 进入 `ACCEPTED` 终态，`rework` 回到 `PLANNING` 并清空执行记录；补齐服务、路由与 HTTP 契约测试。
- **P8.0**：契约冻结——新增 `src/contracts.ts` 定义 Executor v2、控制动作、事件/详情/配置契约；`Config` 增加自动化配置项并默认关闭；补充契约测试。
- **P8.1**：持久控制元数据与 Run 级 Git 隔离——`RunAggregate` 增加 `control`/`runGit`/`events` 与 Issue 进度元数据；服务提供 `runDetail`、`recordProgress`、pause/resume/takeover/release/retry；每次执行持久化运行级集成分支 `taskflow/integration/<runId>` 并在 rework 时清理。
- **P8.2**：内置 Codex Issue Executor——新增 `src/issue-executor.ts`，以 `gpt-5.6-sol`、`workspace-write`、`--ask-for-approval never` 和严格输出 Schema 驱动 `codex exec` 实现单个 Issue；服务将 attemptId、进度事件与自动化结果接入执行循环。
- **P8.3**：自动推进协调器——`automationEnabled` 开启时自动规划（`autoPlan`）、自动执行、自动审查（`autoReview`）、SSE 事件流（`/plugins/taskflow/events`）与人工介入窗口（`WAITING_DECISION`/`WAITING_PERMISSION`、`maxReviewCycles`）。

当前版本 HEAD：`f67e0c4`，测试套件 196 项（typecheck + vitest + build 通过）。

后续阶段：P8.4 及以后待定。

## HTTP 路由

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/plugins/taskflow/state` | 运行台账快照 |
| GET | `/plugins/taskflow/board` | P6 看板快照（待办/进行中/待审查/已完成/失败） |
| GET | `/plugins/taskflow/run` | P8.1 运行详情投影（automation/currentIssue/allowedActions/recentEvents） |
| GET | `/plugins/taskflow/events` | P8.3 SSE 事件流（可选 `?runId=` 过滤，实时推送白名单事件） |
| POST | `/plugins/taskflow/submit` | 创建任务 Run |
| POST | `/plugins/taskflow/command` | 控制命令（cancel/pause/resume/takeover/release/retry） |
| POST | `/plugins/taskflow/plan` | 触发 Codex 规划 |
| POST | `/plugins/taskflow/execute` | 启动/继续执行，认领可调度 Issues（最多 maxConcurrent） |
| POST | `/plugins/taskflow/exec-result` | 上报当前 Issue 执行结果 |
| POST | `/plugins/taskflow/progress` | P8.1 上报自动化执行进度（attempt/phase/heartbeat） |
| POST | `/plugins/taskflow/review` | 触发 P4 Codex 只读审查（PASS/REVISE） |
| POST | `/plugins/taskflow/human-decision` | P7 最终人工验收（`accept` 通过 / `rework` 打回重新规划） |

## 开发

```sh
pnpm install
pnpm run check   # typecheck + test + build
```

`lib/` 为构建产物；安装到 profile 后重启 dsh web 生效：

```sh
dsh plugin --profile web add <本仓库路径>
```

## 目录结构

- `src/index.ts` — 宿主入口：服务装配、system prompt 段、HTTP 路由（webServer 存在时经嵌套 inject 注册）
- `src/service.ts` — TaskFlowService：submit/snapshot/list/command/subscribe/subscribeEvents、plan、startExecution/reportResult、startReview/decideHuman、board、runDetail、recordProgress（P6 看板 / P7 人工验收 / P8.1 控制元数据 / P8.3 自动推进与事件流）
- `src/domain.ts` / `src/repository.ts` — storage-domain 持久化聚合与原子读写
- `src/state.ts` — Run 状态机与合法迁移表
- `src/dag.ts` — Issue 计划校验与依赖拓扑排序
- `src/planner.ts` — Codex CLI 规划执行器
- `src/reviewer.ts` — Codex CLI 只读审查执行器（PASS/REVISE）
- `src/worktree.ts` — Git worktree 管理（建分支/合并/清理）
- `src/executor.ts` — 执行器接口（agent 驱动 / 自动化双模式）
- `src/issue-executor.ts` — P8.2 内置 Codex Issue Executor（workspace-write 单 Issue 实现）
- `src/contracts.ts` — P8 契约冻结（Executor v2、控制动作、事件/详情/配置）
- `src/client/` — 浏览器半体：`conversation.input.dock` 状态卡片（只读投影）
- `build/` — 自 DSH checkout 拷贝的 client bundle 预设（保持与运行版本同步）
- `tests/` — 服务、状态机、DAG、规划器、持久化与执行引擎单元测试

## Model Experience

### What the model sees

当前注入一段 `plugin:taskflow` 通告（order 200），声明插件存在、能力、HTTP 路由与当前 P8.3 阶段能力，模型可据此配合提交、规划、并行执行、结果上报、触发审查、人工验收、查看看板/运行详情/SSE 事件流；自动化开启时自动推进规划、执行与审查，并保留人工介入窗口。

### Token effect

固定一段通告文本；无每轮动态内容。

## Known Limitations and Deferred Work

- P8 自动化默认关闭（`automationEnabled=false`）；开启后自动推进协调器、SSE 与人工介入窗口已实现。
- P4 审查门默认随 `autoReview=true` 自动触发；显式 `/plugins/taskflow/review` 仍可用。
- P7 人工验收门仍为显式触发（`/plugins/taskflow/human-decision`），不会在 `AWAITING_HUMAN` 后自动验收。
- P5 并行执行默认 `maxConcurrent=1`，需通过插件配置调大；worktree 合并采用非快进合并，冲突会导致对应 Issue 失败。
- 执行方为 DSH 会话或自动化 Executor 驱动；`automationEnabled=true` 时由自动推进协调器串联后台流程。
- 客户端卡片只读；写入全部走宿主受控路由。
