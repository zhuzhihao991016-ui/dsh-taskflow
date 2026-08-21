import { describe, expect, it } from 'vitest'
import { assertTaskFlowConfig, codexProfile, resolveTaskFlowConfig } from '../src/config.ts'

describe('Taskflow Codex config', () => {
  it('keeps independent defaults for planning, checkpoint, and final review', () => {
    const config = resolveTaskFlowConfig()

    expect(codexProfile(config, 'planning')).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
    })
    expect(codexProfile(config, 'checkpoint')).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
    })
    expect(codexProfile(config, 'final')).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
    })
  })

  it('resolves user overrides without coupling the three scenes', () => {
    const config = resolveTaskFlowConfig({
      codexPlanningModel: 'gpt-plan',
      codexPlanningEffort: 'low',
      codexCheckpointModel: 'gpt-step',
      codexCheckpointEffort: 'high',
      codexFinalModel: 'gpt-final',
      codexFinalEffort: 'ultra',
    })

    expect(codexProfile(config, 'planning')).toMatchObject({ model: 'gpt-plan', reasoningEffort: 'low' })
    expect(codexProfile(config, 'checkpoint')).toMatchObject({ model: 'gpt-step', reasoningEffort: 'high' })
    expect(codexProfile(config, 'final')).toMatchObject({ model: 'gpt-final', reasoningEffort: 'ultra' })
  })

  it('keeps defaults when optional fields are explicitly undefined', () => {
    const config = resolveTaskFlowConfig({
      allowedRepoRoots: undefined,
      maxConcurrent: undefined,
      codexPlanningModel: undefined,
    })

    expect(config.allowedRepoRoots).toEqual([])
    expect(config.maxConcurrent).toBe(1)
    expect(config.codexPlanningModel).toBe('gpt-5.6-sol')
  })

  it('rejects model values that could alter strict config syntax', () => {
    expect(() => assertTaskFlowConfig({ codexPlanningModel: 'gpt"\nmalformed' })).toThrow(/模型名称格式无效/)
  })

  it('rejects Windows command wrappers that require shell execution', () => {
    expect(() => assertTaskFlowConfig({ codexCliPath: 'C:/tools/codex.cmd' })).toThrow(/不支持 \.cmd\/\.bat/)
  })
})
