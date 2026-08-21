/** Native Plugins-settings card for Taskflow and its Codex CLI integration. */

import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CODEX_REASONING_EFFORTS,
  DEFAULT_CODEX_PROFILES,
  type CodexReasoningEffort,
} from '../codex-profile.ts'
import css from './taskflow-settings.module.css'

export interface TaskFlowSettingsValue {
  announceToAgent?: boolean
  enabled?: boolean
  allowedRepoRoots?: string[]
  codexCliPath?: string
  codexPlanningModel?: string
  codexPlanningEffort?: CodexReasoningEffort
  codexCheckpointModel?: string
  codexCheckpointEffort?: CodexReasoningEffort
  codexFinalModel?: string
  codexFinalEffort?: CodexReasoningEffort
  maxConcurrent?: number
  integrationBranch?: string
  worktreesRoot?: string
  automationEnabled?: boolean
  autoPlan?: boolean
  autoReview?: boolean
  maxExecutorProcesses?: number
  maxReviewCycles?: number
  requireExecutionPermission?: boolean
  teamBoardSync?: boolean
  teamBoardTaskPrefix?: string
  teamBoardOwner?: string
}

interface Draft {
  announceToAgent: boolean
  enabled: boolean
  allowedRepoRoots: string
  codexCliPath: string
  codexPlanningModel: string
  codexPlanningEffort: CodexReasoningEffort
  codexCheckpointModel: string
  codexCheckpointEffort: CodexReasoningEffort
  codexFinalModel: string
  codexFinalEffort: CodexReasoningEffort
  maxConcurrent: string
  integrationBranch: string
  worktreesRoot: string
  automationEnabled: boolean
  autoPlan: boolean
  autoReview: boolean
  maxExecutorProcesses: string
  maxReviewCycles: string
  requireExecutionPermission: boolean
  teamBoardSync: boolean
  teamBoardTaskPrefix: string
  teamBoardOwner: string
}

interface CodexModel {
  slug: string
  displayName: string
  description: string
  defaultReasoningEffort: CodexReasoningEffort
  reasoningEfforts: Array<{ effort: CodexReasoningEffort; description: string }>
}

interface ModelsResponse {
  ok: boolean
  source?: 'live' | 'bundled'
  cached?: boolean
  models?: CodexModel[]
  error?: string
}

interface AuthResponse {
  ok: boolean
  available?: boolean
  authenticated?: boolean
  error?: string
}

const DEFAULT_DRAFT: Draft = {
  announceToAgent: true,
  enabled: true,
  allowedRepoRoots: '',
  codexCliPath: '',
  codexPlanningModel: DEFAULT_CODEX_PROFILES.planning.model,
  codexPlanningEffort: DEFAULT_CODEX_PROFILES.planning.reasoningEffort,
  codexCheckpointModel: DEFAULT_CODEX_PROFILES.checkpoint.model,
  codexCheckpointEffort: DEFAULT_CODEX_PROFILES.checkpoint.reasoningEffort,
  codexFinalModel: DEFAULT_CODEX_PROFILES.final.model,
  codexFinalEffort: DEFAULT_CODEX_PROFILES.final.reasoningEffort,
  maxConcurrent: '1',
  integrationBranch: 'taskflow/integration',
  worktreesRoot: '',
  automationEnabled: true,
  autoPlan: true,
  autoReview: true,
  maxExecutorProcesses: '2',
  maxReviewCycles: '3',
  requireExecutionPermission: true,
  teamBoardSync: true,
  teamBoardTaskPrefix: '[taskflow]',
  teamBoardOwner: '',
}

const EFFORT_LABELS: Record<CodexReasoningEffort, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
}

function draftFrom(value: TaskFlowSettingsValue): Draft {
  return {
    ...DEFAULT_DRAFT,
    ...value,
    allowedRepoRoots: (value.allowedRepoRoots ?? []).join('\n'),
    maxConcurrent: String(value.maxConcurrent ?? DEFAULT_DRAFT.maxConcurrent),
    maxExecutorProcesses: String(value.maxExecutorProcesses ?? DEFAULT_DRAFT.maxExecutorProcesses),
    maxReviewCycles: String(value.maxReviewCycles ?? DEFAULT_DRAFT.maxReviewCycles),
  }
}

function settingsFrom(draft: Draft): TaskFlowSettingsValue {
  return {
    announceToAgent: draft.announceToAgent,
    enabled: draft.enabled,
    allowedRepoRoots: draft.allowedRepoRoots.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
    codexCliPath: draft.codexCliPath.trim(),
    codexPlanningModel: draft.codexPlanningModel.trim(),
    codexPlanningEffort: draft.codexPlanningEffort,
    codexCheckpointModel: draft.codexCheckpointModel.trim(),
    codexCheckpointEffort: draft.codexCheckpointEffort,
    codexFinalModel: draft.codexFinalModel.trim(),
    codexFinalEffort: draft.codexFinalEffort,
    maxConcurrent: Number(draft.maxConcurrent),
    integrationBranch: draft.integrationBranch.trim(),
    worktreesRoot: draft.worktreesRoot.trim(),
    automationEnabled: draft.automationEnabled,
    autoPlan: draft.autoPlan,
    autoReview: draft.autoReview,
    maxExecutorProcesses: Number(draft.maxExecutorProcesses),
    maxReviewCycles: Number(draft.maxReviewCycles),
    requireExecutionPermission: draft.requireExecutionPermission,
    teamBoardSync: draft.teamBoardSync,
    teamBoardTaskPrefix: draft.teamBoardTaskPrefix,
    teamBoardOwner: draft.teamBoardOwner.trim(),
  }
}

function sameDraft(left: Draft | undefined, right: Draft | undefined): boolean {
  return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right)
}

function validPositiveInteger(value: string): boolean {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1
}

const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/

function isValidDraft(draft: Draft, models: CodexModel[]): boolean {
  if (!validPositiveInteger(draft.maxConcurrent)) return false
  if (!validPositiveInteger(draft.maxExecutorProcesses)) return false
  if (!validPositiveInteger(draft.maxReviewCycles)) return false
  if (draft.integrationBranch.trim() === '') return false
  if (/\.(?:cmd|bat)$/i.test(draft.codexCliPath.trim())) return false
  const pairs: Array<[string, CodexReasoningEffort]> = [
    [draft.codexPlanningModel, draft.codexPlanningEffort],
    [draft.codexCheckpointModel, draft.codexCheckpointEffort],
    [draft.codexFinalModel, draft.codexFinalEffort],
  ]
  return pairs.every(([modelSlug, effort]) => {
    const slug = modelSlug.trim()
    if (!MODEL_SLUG.test(slug)) return false
    const model = models.find(candidate => candidate.slug === slug)
    return model === undefined || model.reasoningEfforts.length === 0
      || model.reasoningEfforts.some(option => option.effort === effort)
  })
}

export interface TaskFlowSettingsProps {
  settings: SettingsScope<TaskFlowSettingsValue>
}

/** Create a zero-prop slot component bound to this plugin lifecycle's settings scope. */
export function createTaskFlowSettingsCard(settings: SettingsScope<TaskFlowSettingsValue>) {
  return function TaskFlowSettingsCard() {
    return <TaskFlowSettings settings={settings} />
  }
}

export function TaskFlowSettings({ settings }: TaskFlowSettingsProps) {
  const snapshot = useSyncExternalStore(
    listener => settings.subscribe(listener),
    () => settings.getSnapshot(),
    () => settings.getSnapshot(),
  )
  const [draft, setDraft] = useState<Draft>()
  const [baseline, setBaseline] = useState<Draft>()
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [models, setModels] = useState<CodexModel[]>([])
  const [modelSource, setModelSource] = useState<'live' | 'bundled'>()
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [auth, setAuth] = useState<{ available: boolean; authenticated: boolean }>()
  const [authLoading, setAuthLoading] = useState(false)
  const [loginLoading, setLoginLoading] = useState(false)
  const modelListId = useId()

  const dirty = draft !== undefined && baseline !== undefined && !sameDraft(draft, baseline)
  useEffect(() => {
    if (snapshot.status !== 'ready' || snapshot.value === undefined || saving || dirty) return
    const next = draftFrom(snapshot.value)
    setDraft(next)
    setBaseline(next)
  }, [snapshot.revision, snapshot.status, snapshot.value, saving, dirty])

  async function loadModels(refresh: boolean): Promise<void> {
    setModelsLoading(true)
    setModelsError('')
    try {
      const suffix = refresh ? '?refresh=1' : ''
      const response = await fetch('/plugins/taskflow/codex/models' + suffix)
      const body = await response.json() as ModelsResponse
      if (!response.ok || !body.ok || body.models === undefined) {
        throw new Error(body.error ?? '无法读取 Codex 模型列表')
      }
      setModels(body.models)
      setModelSource(body.source)
    } catch (error) {
      setModelsError((error as Error).message)
    } finally {
      setModelsLoading(false)
    }
  }

  async function loadAuth(): Promise<void> {
    setAuthLoading(true)
    try {
      const response = await fetch('/plugins/taskflow/codex/auth')
      const body = await response.json() as AuthResponse
      setAuth({
        available: response.ok && body.ok && body.available === true,
        authenticated: response.ok && body.ok && body.authenticated === true,
      })
    } catch {
      setAuth({ available: false, authenticated: false })
    } finally {
      setAuthLoading(false)
    }
  }

  useEffect(() => {
    void loadModels(false)
    void loadAuth()
  }, [])

  async function launchLogin(): Promise<void> {
    setLoginLoading(true)
    setNotice('')
    try {
      const response = await fetch('/plugins/taskflow/codex/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const body = await response.json() as { ok?: boolean; error?: string }
      if (!response.ok || body.ok !== true) throw new Error(body.error ?? '无法启动 Codex 登录')
      setNotice('已打开 Codex 登录流程；完成后请刷新账号状态。')
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setLoginLoading(false)
    }
  }

  async function save(): Promise<void> {
    if (draft === undefined || baseline === undefined || !isValidDraft(draft, models)) return
    setSaving(true)
    setNotice('')
    const next = settingsFrom(draft)
    const previous = settingsFrom(baseline)
    const changed = (Object.keys(next) as Array<keyof TaskFlowSettingsValue>)
      .filter(field => JSON.stringify(next[field]) !== JSON.stringify(previous[field]))
    try {
      for (const field of changed) {
        await settings.set(field, next[field])
      }
      const persisted = settings.getSnapshot()
      if (persisted.status !== 'ready' || persisted.value === undefined) {
        throw new Error('settings snapshot unavailable after save')
      }
      const persistedSettings = settingsFrom(draftFrom(persisted.value))
      if (changed.some(field => JSON.stringify(persistedSettings[field]) !== JSON.stringify(next[field]))) {
        throw new Error('settings write was not persisted')
      }
      const normalized = draftFrom(persisted.value)
      setDraft(normalized)
      setBaseline(normalized)
      setNotice('设置已保存。Codex 场景从下一次调用起生效；其余工作流选项重启插件后生效。')
    } catch {
      setNotice('设置保存失败，请刷新后重试。')
    } finally {
      setSaving(false)
    }
  }

  function discard(): void {
    if (baseline === undefined) return
    setDraft({ ...baseline })
    setNotice('')
  }

  function edit<K extends keyof Draft>(field: K, value: Draft[K]): void {
    setDraft(current => current === undefined ? current : { ...current, [field]: value })
    setNotice('')
  }

  function effortOptions(modelSlug: string): CodexReasoningEffort[] {
    const selected = models.find(model => model.slug === modelSlug.trim())
    return selected !== undefined && selected.reasoningEfforts.length > 0
      ? selected.reasoningEfforts.map(option => option.effort)
      : [...CODEX_REASONING_EFFORTS]
  }

  function editModel(
    modelField: 'codexPlanningModel' | 'codexCheckpointModel' | 'codexFinalModel',
    effortField: 'codexPlanningEffort' | 'codexCheckpointEffort' | 'codexFinalEffort',
    slug: string,
  ): void {
    setDraft((current) => {
      if (current === undefined) return current
      const selected = models.find(model => model.slug === slug.trim())
      const supported = selected?.reasoningEfforts.map(option => option.effort) ?? []
      const currentEffort = current[effortField]
      return {
        ...current,
        [modelField]: slug,
        [effortField]: supported.length > 0 && !supported.includes(currentEffort)
          ? selected?.defaultReasoningEffort ?? supported[0]
          : currentEffort,
      }
    })
    setNotice('')
  }

  const invalid = draft === undefined || !isValidDraft(draft, models)
  const sourceText = modelSource === 'live' ? '在线目录' : modelSource === 'bundled' ? 'CLI 内置目录' : '尚未读取'
  const authText = authLoading
    ? '检查中…'
    : auth?.authenticated === true
      ? '已登录'
      : auth?.available === true
        ? '未登录'
        : 'CLI 不可用或状态未知'

  const sceneRows = useMemo(() => {
    if (draft === undefined) return []
    return [
      {
        key: 'planning',
        title: '规划',
        hint: '首次拆分与 REPLAN',
        modelField: 'codexPlanningModel' as const,
        effortField: 'codexPlanningEffort' as const,
      },
      {
        key: 'checkpoint',
        title: '步审',
        hint: '每个 Issue 完成后的方向审查',
        modelField: 'codexCheckpointModel' as const,
        effortField: 'codexCheckpointEffort' as const,
      },
      {
        key: 'final',
        title: '终审',
        hint: '全部步骤完成后的集成审查',
        modelField: 'codexFinalModel' as const,
        effortField: 'codexFinalEffort' as const,
      },
    ]
  }, [draft])

  if (snapshot.status !== 'ready' || draft === undefined) return null

  return (
    <li className={css.card}>
      <details>
        <summary className={css.summary}>
          <span>
            <strong>Taskflow</strong>
            <small>Codex 三阶段编排、自动执行与仓库隔离</small>
          </span>
          {dirty ? <span className={css.unsaved}>未保存</span> : null}
        </summary>

        <div className={css.body}>
          {!snapshot.writable ? <p className={css.warning}>当前设置存储为只读，无法保存修改。</p> : null}

          <section className={css.section} aria-labelledby="taskflow-codex-heading">
            <div className={css.sectionHead}>
              <div>
                <h3 id="taskflow-codex-heading">Codex CLI</h3>
                <p>模型列表来自当前 Codex CLI；账号接口只返回“是否登录”。</p>
              </div>
              <div className={css.actions}>
                <button type="button" onClick={() => { void loadModels(true) }} disabled={modelsLoading}>
                  {modelsLoading ? '读取中…' : '刷新模型'}
                </button>
                <button type="button" onClick={() => { void loadAuth() }} disabled={authLoading}>刷新账号状态</button>
                <button type="button" onClick={() => { void launchLogin() }} disabled={loginLoading}>
                  {loginLoading ? '启动中…' : '打开 Codex 登录'}
                </button>
              </div>
            </div>

            <label className={css.field}>
              <span>CLI 入口</span>
              <input
                value={draft.codexCliPath}
                onChange={event => { edit('codexCliPath', event.target.value) }}
                placeholder="留空自动发现 Codex CLI"
                disabled={!snapshot.writable}
              />
            </label>
            <div className={css.statusLine}>
              <span>模型来源：{sourceText}</span>
              <span>账号状态：{authText}</span>
            </div>
            {modelsError !== '' ? <p className={css.error} role="status">{modelsError}</p> : null}

            <datalist id={modelListId}>
              {models.map(model => <option key={model.slug} value={model.slug}>{model.displayName}</option>)}
            </datalist>
            <div className={css.scenes}>
              {sceneRows.map((scene) => {
                const model = draft[scene.modelField]
                const effort = draft[scene.effortField]
                return (
                  <fieldset key={scene.key} className={css.scene}>
                    <legend>{scene.title}</legend>
                    <p>{scene.hint}</p>
                    <label className={css.field}>
                      <span>模型</span>
                      <input
                        list={modelListId}
                        value={model}
                        onChange={event => {
                          editModel(scene.modelField, scene.effortField, event.target.value)
                        }}
                        disabled={!snapshot.writable}
                      />
                    </label>
                    <label className={css.field}>
                      <span>思考强度</span>
                      <select
                        value={effort}
                        onChange={event => {
                          edit(scene.effortField, event.target.value as CodexReasoningEffort)
                        }}
                        disabled={!snapshot.writable}
                      >
                        {effortOptions(model).map(option => (
                          <option key={option} value={option}>{EFFORT_LABELS[option]}</option>
                        ))}
                      </select>
                    </label>
                  </fieldset>
                )
              })}
            </div>
          </section>

          <section className={css.section} aria-labelledby="taskflow-automation-heading">
            <div className={css.sectionHead}>
              <div>
                <h3 id="taskflow-automation-heading">自动化与并发</h3>
                <p>控制自动规划、审查、执行放行与并发边界。</p>
              </div>
            </div>
            <div className={css.toggleGrid}>
              {([
                ['enabled', '启用 Taskflow（重启生效）'],
                ['automationEnabled', '启用自动执行'],
                ['autoPlan', '自动规划'],
                ['autoReview', '自动步审与终审'],
                ['requireExecutionPermission', '执行前人工放行'],
              ] as const).map(([field, label]) => (
                <label key={field} className={css.toggle}>
                  <input
                    type="checkbox"
                    checked={draft[field]}
                    onChange={event => { edit(field, event.target.checked) }}
                    disabled={!snapshot.writable}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <div className={css.fieldGrid}>
              {([
                ['maxConcurrent', '单工作流并行 Issue'],
                ['maxExecutorProcesses', '全局执行进程上限'],
                ['maxReviewCycles', '最大返工轮数'],
              ] as const).map(([field, label]) => (
                <label key={field} className={css.field}>
                  <span>{label}</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={draft[field]}
                    onChange={event => { edit(field, event.target.value) }}
                    disabled={!snapshot.writable}
                  />
                </label>
              ))}
            </div>
          </section>

          <section className={css.section} aria-labelledby="taskflow-repo-heading">
            <div className={css.sectionHead}>
              <div>
                <h3 id="taskflow-repo-heading">仓库与集成</h3>
                <p>每行一个允许规划的仓库根；worktree 留空时自动选择安全的同级目录。</p>
              </div>
            </div>
            <label className={css.field}>
              <span>允许的仓库根目录</span>
              <textarea
                rows={3}
                value={draft.allowedRepoRoots}
                onChange={event => { edit('allowedRepoRoots', event.target.value) }}
                disabled={!snapshot.writable}
              />
            </label>
            <div className={css.fieldGrid}>
              <label className={css.field}>
                <span>集成分支</span>
                <input
                  value={draft.integrationBranch}
                  onChange={event => { edit('integrationBranch', event.target.value) }}
                  disabled={!snapshot.writable}
                />
              </label>
              <label className={css.field}>
                <span>Worktree 根目录</span>
                <input
                  value={draft.worktreesRoot}
                  onChange={event => { edit('worktreesRoot', event.target.value) }}
                  placeholder="留空自动选择"
                  disabled={!snapshot.writable}
                />
              </label>
            </div>
          </section>

          <section className={css.section} aria-labelledby="taskflow-integration-heading">
            <div className={css.sectionHead}>
              <div>
                <h3 id="taskflow-integration-heading">提示与看板</h3>
                <p>控制智能体能力提示，以及可选的 team-board 镜像。</p>
              </div>
            </div>
            <div className={css.toggleGrid}>
              <label className={css.toggle}>
                <input
                  type="checkbox"
                  checked={draft.announceToAgent}
                  onChange={event => { edit('announceToAgent', event.target.checked) }}
                  disabled={!snapshot.writable}
                />
                <span>向智能体提示 Taskflow</span>
              </label>
              <label className={css.toggle}>
                <input
                  type="checkbox"
                  checked={draft.teamBoardSync}
                  onChange={event => { edit('teamBoardSync', event.target.checked) }}
                  disabled={!snapshot.writable}
                />
                <span>同步到 team-board</span>
              </label>
            </div>
            <div className={css.fieldGrid}>
              <label className={css.field}>
                <span>镜像任务前缀</span>
                <input
                  value={draft.teamBoardTaskPrefix}
                  onChange={event => { edit('teamBoardTaskPrefix', event.target.value) }}
                  disabled={!snapshot.writable}
                />
              </label>
              <label className={css.field}>
                <span>镜像任务负责人</span>
                <input
                  value={draft.teamBoardOwner}
                  onChange={event => { edit('teamBoardOwner', event.target.value) }}
                  placeholder="留空不指定"
                  disabled={!snapshot.writable}
                />
              </label>
            </div>
          </section>

          {notice !== '' ? <p className={css.notice} role="status">{notice}</p> : null}
          {invalid ? <p className={css.error}>请检查 CLI 入口、模型、思考强度、集成分支和正整数配置。</p> : null}
          <div className={css.footer}>
            <button type="button" onClick={discard} disabled={!dirty || saving}>放弃修改</button>
            <button
              type="button"
              className={css.primary}
              onClick={() => { void save() }}
              disabled={!snapshot.writable || !dirty || invalid || saving}
            >
              {saving ? '保存中…' : '保存设置'}
            </button>
          </div>
        </div>
      </details>
    </li>
  )
}
