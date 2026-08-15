# dsh-taskflow

DSH 全自动任务工作流插件：任务提出后由 Codex CLI 规划拆分为 Issue（带验收标准与依赖 DAG）→ 发布看板 → DSH 认领执行（串行/并行）→ Codex 只读审查决定打回/通过 → 按依赖序推进 → 最终人工验收。人工只在"提出任务"与"最终验收"介入。

## 状态

**P0（当前）**：双端插件骨架纵切——宿主服务（内存台账）+ 同源 JSON 路由（`/plugins/taskflow/state|submit|command`）+ 输入 dock 状态卡片 + 模型通告段。核心零改动，可装卸。

后续阶段：P1 持久内核（storage-domain SQLite 聚合）、P2 Codex Planner、P3 DSH Runner、P4 Reviewer/Rework、P5 DAG/Worktree、P6 Board/迁移、P7 收口试运行。

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
- `src/service.ts` — TaskFlowService：submit/snapshot/list/command/subscribe；P0 仅 RECEIVED/CANCELLED
- `src/client/` — 浏览器半体：`conversation.input.dock` 状态卡片（只读投影）
- `build/` — 自 DSH checkout 拷贝的 client bundle 预设（保持与运行版本同步）
- `tests/` — 服务台账单元测试

## Model Experience

### What the model sees

P0 注入一段 `plugin:taskflow` 通告（order 200），声明插件存在、能力与当前阶段限制。

### Token effect

固定一段通告文本；无每轮动态内容。

## Known Limitations and Deferred Work

- P0 台账仅内存，重启即失（P1 迁移 storage-domain/SQLite 聚合 + 租约恢复）。
- 无规划/执行/审查/调度（P2–P5）；无人工验收门（P7）。
- 客户端卡片只读；写入全部走宿主受控路由。
