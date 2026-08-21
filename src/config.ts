/** Taskflow composition and user-settings contract. */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_AUTOMATION_CONFIG } from './contracts.ts'
import {
  CODEX_REASONING_EFFORTS,
  DEFAULT_CODEX_PROFILES,
  type CodexInvocationProfile,
  type CodexReasoningEffort,
  type CodexScene,
} from './codex-profile.ts'

/** Plugin config; schema defaults are applied by the loader and settings service. */
export interface Config {
  /** When true (default), announce the plugin in every agent's system prompt. */
  announceToAgent?: boolean
  /** Master switch for the plugin. */
  enabled?: boolean
  /** Canonical repo roots the planner may inspect; empty = planning disabled. */
  allowedRepoRoots?: string[]
  /** Codex CLI entry override; default resolves via CODEX_CLI_PATH or platform. */
  codexCliPath?: string
  /** Model used to plan and replan workflow issues. */
  codexPlanningModel?: string
  /** Reasoning effort used to plan and replan workflow issues. */
  codexPlanningEffort?: CodexReasoningEffort
  /** Model used after each issue for the directional checkpoint review. */
  codexCheckpointModel?: string
  /** Reasoning effort used by the directional checkpoint review. */
  codexCheckpointEffort?: CodexReasoningEffort
  /** Model used for the final integration review. */
  codexFinalModel?: string
  /** Reasoning effort used for the final integration review. */
  codexFinalEffort?: CodexReasoningEffort
  /** P5: maximum concurrent issues (default 1 = serial-compatible). */
  maxConcurrent?: number
  /** P5: persistent branch where successful issue worktrees are merged. */
  integrationBranch?: string
  /** P5: optional worktree root; omitted defaults to a hashed sibling directory outside the repo. */
  worktreesRoot?: string
  /** P8: master switch for the automated executor/automation. */
  automationEnabled?: boolean
  /** P8: when automation is enabled, automatically start planning. */
  autoPlan?: boolean
  /** P8: when automation is enabled, automatically trigger Codex review. */
  autoReview?: boolean
  /** P8: global cap on concurrent Codex executor processes. */
  maxExecutorProcesses?: number
  /** P8: max review/rework cycles before asking a human. */
  maxReviewCycles?: number
  /** P8.4: wait for human release before automatic execution starts. */
  requireExecutionPermission?: boolean
  /** Optional integration: mirror taskflow cards to ctx.teamBoard. */
  teamBoardSync?: boolean
  /** Subject marker used to recognize taskflow-created team-board tasks. */
  teamBoardTaskPrefix?: string
  /** Owner assigned to mirrored team-board tasks (default: none). */
  teamBoardOwner?: string
}

export type ResolvedConfig = Required<Config>

export const DEFAULT_CONFIG: ResolvedConfig = {
  announceToAgent: true,
  enabled: true,
  allowedRepoRoots: [],
  codexCliPath: '',
  codexPlanningModel: DEFAULT_CODEX_PROFILES.planning.model,
  codexPlanningEffort: DEFAULT_CODEX_PROFILES.planning.reasoningEffort,
  codexCheckpointModel: DEFAULT_CODEX_PROFILES.checkpoint.model,
  codexCheckpointEffort: DEFAULT_CODEX_PROFILES.checkpoint.reasoningEffort,
  codexFinalModel: DEFAULT_CODEX_PROFILES.final.model,
  codexFinalEffort: DEFAULT_CODEX_PROFILES.final.reasoningEffort,
  maxConcurrent: 1,
  integrationBranch: 'taskflow/integration',
  worktreesRoot: '',
  automationEnabled: DEFAULT_AUTOMATION_CONFIG.enabled,
  autoPlan: DEFAULT_AUTOMATION_CONFIG.autoPlan,
  autoReview: DEFAULT_AUTOMATION_CONFIG.autoReview,
  maxExecutorProcesses: DEFAULT_AUTOMATION_CONFIG.maxExecutorProcesses,
  maxReviewCycles: DEFAULT_AUTOMATION_CONFIG.maxReviewCycles,
  requireExecutionPermission: DEFAULT_AUTOMATION_CONFIG.requireExecutionPermission,
  teamBoardSync: true,
  teamBoardTaskPrefix: '[taskflow]',
  teamBoardOwner: '',
}

function effortSchema(defaultValue: CodexReasoningEffort): z<CodexReasoningEffort> {
  return z.union([
    z.const('minimal'),
    z.const('low'),
    z.const('medium'),
    z.const('high'),
    z.const('xhigh'),
    z.const('max'),
    z.const('ultra'),
  ]).default(defaultValue)
}

export const Config: z<Config> = z.object({
  announceToAgent: z.boolean().default(DEFAULT_CONFIG.announceToAgent).description('向智能体提示 Taskflow 能力'),
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled).description('启用 Taskflow 插件'),
  allowedRepoRoots: z.array(z.string()).default(DEFAULT_CONFIG.allowedRepoRoots).description('允许规划器读取的仓库根目录'),
  codexCliPath: z.string().default(DEFAULT_CONFIG.codexCliPath).description('Codex CLI 入口；留空自动发现'),
  codexPlanningModel: z.string().default(DEFAULT_CONFIG.codexPlanningModel).description('规划与重新规划使用的 Codex 模型'),
  codexPlanningEffort: effortSchema(DEFAULT_CONFIG.codexPlanningEffort).description('规划与重新规划的思考强度'),
  codexCheckpointModel: z.string().default(DEFAULT_CONFIG.codexCheckpointModel).description('每步方向审查使用的 Codex 模型'),
  codexCheckpointEffort: effortSchema(DEFAULT_CONFIG.codexCheckpointEffort).description('每步方向审查的思考强度'),
  codexFinalModel: z.string().default(DEFAULT_CONFIG.codexFinalModel).description('全部步骤完成后终审使用的 Codex 模型'),
  codexFinalEffort: effortSchema(DEFAULT_CONFIG.codexFinalEffort).description('全部步骤完成后终审的思考强度'),
  maxConcurrent: z.number().step(1).min(1).default(DEFAULT_CONFIG.maxConcurrent).description('单个工作流并行 Issue 上限'),
  integrationBranch: z.string().default(DEFAULT_CONFIG.integrationBranch).description('成功 Issue 合并到的集成分支'),
  worktreesRoot: z.string().default(DEFAULT_CONFIG.worktreesRoot).description('Git worktree 根目录；留空自动选择'),
  automationEnabled: z.boolean().default(DEFAULT_CONFIG.automationEnabled).description('启用自动执行器与自动推进'),
  autoPlan: z.boolean().default(DEFAULT_CONFIG.autoPlan).description('提交任务后自动规划'),
  autoReview: z.boolean().default(DEFAULT_CONFIG.autoReview).description('自动触发每步审查与终审'),
  maxExecutorProcesses: z.number().step(1).min(1).default(DEFAULT_CONFIG.maxExecutorProcesses).description('全局 Codex 执行进程上限'),
  maxReviewCycles: z.number().step(1).min(1).default(DEFAULT_CONFIG.maxReviewCycles).description('进入人工介入前的最大返工轮数'),
  requireExecutionPermission: z.boolean().default(DEFAULT_CONFIG.requireExecutionPermission).description('自动执行前等待人工放行'),
  teamBoardSync: z.boolean().default(DEFAULT_CONFIG.teamBoardSync).description('同步 Taskflow 卡片到 team-board'),
  teamBoardTaskPrefix: z.string().default(DEFAULT_CONFIG.teamBoardTaskPrefix).description('team-board 镜像任务前缀'),
  teamBoardOwner: z.string().default(DEFAULT_CONFIG.teamBoardOwner).description('team-board 镜像任务负责人；留空不指定'),
})

/** Fill all schema defaults without mutating caller-owned arrays. */
export function resolveTaskFlowConfig(value?: Config): ResolvedConfig {
  const overrides = Object.fromEntries(
    Object.entries(value ?? {}).filter(([, candidate]) => candidate !== undefined),
  ) as Config
  const resolved = { ...DEFAULT_CONFIG, ...overrides }
  return { ...resolved, allowedRepoRoots: [...resolved.allowedRepoRoots] }
}

const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/

/** Cross-field and forwarding validation used by the settings provider. */
export function assertTaskFlowConfig(value: Config): void {
  const resolved = resolveTaskFlowConfig(value)
  if (/\.(?:cmd|bat)$/i.test(resolved.codexCliPath.trim())) {
    throw new Error('taskflow: Codex CLI 入口不支持 .cmd/.bat 包装器')
  }
  const models = [
    resolved.codexPlanningModel,
    resolved.codexCheckpointModel,
    resolved.codexFinalModel,
  ]
  if (models.some(model => !MODEL_SLUG.test(model))) {
    throw new Error('taskflow: Codex 模型名称格式无效')
  }
  const efforts = [
    resolved.codexPlanningEffort,
    resolved.codexCheckpointEffort,
    resolved.codexFinalEffort,
  ]
  if (efforts.some(effort => !CODEX_REASONING_EFFORTS.includes(effort))) {
    throw new Error('taskflow: Codex 思考强度无效')
  }
}

/** Resolve one of the three independent Codex scene profiles. */
export function codexProfile(config: ResolvedConfig, scene: CodexScene): CodexInvocationProfile {
  if (scene === 'planning') {
    return {
      cliPath: config.codexCliPath,
      model: config.codexPlanningModel,
      reasoningEffort: config.codexPlanningEffort,
    }
  }
  if (scene === 'checkpoint') {
    return {
      cliPath: config.codexCliPath,
      model: config.codexCheckpointModel,
      reasoningEffort: config.codexCheckpointEffort,
    }
  }
  return {
    cliPath: config.codexCliPath,
    model: config.codexFinalModel,
    reasoningEffort: config.codexFinalEffort,
  }
}
