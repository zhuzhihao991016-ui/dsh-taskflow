# dsh-taskflow

DSH 全自动任务工作流插件：任务提出后由 Codex CLI 规划拆分为 Issue（带验收标准与依赖 DAG）→ 发布看板 → DSH 认领执行（串行/并行）→ Codex 只读审查决定打回/通过 → 按依赖序推进 → 最终人工验收。人工只在"提出任务"与"最终验收"介入。

## 状态

**P4（当前）**：已打通「提交任务 → Codex 规划拆分 Issue → DSH 串行认领执行 → 全部完成进入集成审查 → Codex 只读审查（PASS 人工验收 / REVISE 返工）→ 人工验收」的主链路。

已完成：

- **P0**：双端插件骨架——宿主服务（持久化运行台账）、同源 JSON 路由、输入 dock 状态卡片、模型通告段。
- **P1**：持久内核——Run 聚合、状态机、DAG 校验、幂等迁移、重启恢复。
- **P2**：Codex Planner——进程执行器、真实 JSONL 事件解析、严格输出 Schema、超时重试、规划状态流、repoRoot 白名单/规范化。
- **P2.5**：规划并发与幂等收敛——显式幂等键、planning 单飞、持久化 PLANNING 转换后才应答、重启续跑。
- **P3**：串行执行引擎——`READY → EXECUTING` 确定性认领（依赖拓扑序、一次一个）、`exec-result` 上报、失败即 `FAILED`、全部完成进入 `INTEGRATION_REVIEW`；支持 agent 驱动与自动化 Executor 双模式、重启恢复。
- **P4**：Reviewer/Rework——`INTEGRATION_REVIEW` 后经 `/plugins/taskflow/review` 触发 Codex 只读审查（`codex exec review`，模型 `gpt-5.6-sol`、推理强度 `high`、只读沙箱）；PASS → `AWAITING_HUMAN`，REVISE → `EXECUTING` 并重置返工 Issue（含下游依赖）供串行执行器重新认领；审查记录持久化到 Run 聚合。

当前版本 HEAD：`79dfd51`，测试套件 114 项（typecheck + vitest + build 通过）。

后续阶段：P5 DAG/Worktree、P6 Board/迁移、P7 收口试运行。

## HTTP 路由

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/plugins/taskflow/state` | 运行台账快照 |
| POST | `/plugins/taskflow/submit` | 创建任务 Run |
| POST | `/plugins/taskflow/command` | 执行命令（当前支持 cancel） |
| POST | `/plugins/taskflow/plan` | 触发 Codex 规划 |
| POST | `/plugins/taskflow/execute` | 启动/继续串行执行，认领当前 Issue |
| POST | `/plugins/taskflow/exec-result` | 上报当前 Issue 执行结果 |
| POST | `/plugins/taskflow/review` | 触发 P4 Codex 只读审查（PASS/REVISE） |

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
- `src/service.ts` — TaskFlowService：submit/snapshot/list/command/subscribe、plan、startExecution/reportResult
- `src/domain.ts` / `src/repository.ts` — storage-domain 持久化聚合与原子读写
- `src/state.ts` — Run 状态机与合法迁移表
- `src/dag.ts` — Issue 计划校验与依赖拓扑排序
- `src/planner.ts` — Codex CLI 规划执行器
- `src/reviewer.ts` — Codex CLI 只读审查执行器（PASS/REVISE）
- `src/executor.ts` — 执行器接口（agent 驱动 / 自动化双模式）
- `src/client/` — 浏览器半体：`conversation.input.dock` 状态卡片（只读投影）
- `build/` — 自 DSH checkout 拷贝的 client bundle 预设（保持与运行版本同步）
- `tests/` — 服务、状态机、DAG、规划器、持久化与执行引擎单元测试

## Model Experience

### What the model sees

当前注入一段 `plugin:taskflow` 通告（order 200），声明插件存在、能力、HTTP 路由与当前 P4 阶段能力，模型可据此配合提交、规划、执行、结果上报与触发审查。

### Token effect

固定一段通告文本；无每轮动态内容。

## Known Limitations and Deferred Work

- P5–P7 未实现：并行执行、worktree 隔离、看板/迁移、最终人工验收门。
- P4 审查门为显式触发（`/plugins/taskflow/review`），不会在进入 `INTEGRATION_REVIEW` 后自动启动。
- 执行方为 DSH 会话或自动化 Executor 显式驱动；没有后台自动连续执行器。
- 客户端卡片只读；写入全部走宿主受控路由。
