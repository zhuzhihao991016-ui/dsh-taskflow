/** Codex invocation settings shared by the Host adapters and browser card. */

/** Reasoning levels accepted by current Codex CLI model catalogs. */
export const CODEX_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const

export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number]

/** The three Codex roles Taskflow configures independently. */
export type CodexScene = 'planning' | 'checkpoint' | 'final'

/** One complete, shell-safe Codex invocation profile. */
export interface CodexInvocationProfile {
  /** Optional CLI entry override; an empty value falls back to normal discovery. */
  cliPath?: string
  /** Model slug passed as one argv value to --model. */
  model: string
  /** Reasoning level serialized into model_reasoning_effort. */
  reasoningEffort: CodexReasoningEffort
}

export const DEFAULT_CODEX_PROFILES: Record<CodexScene, Omit<CodexInvocationProfile, 'cliPath'>> = {
  planning: { model: 'gpt-5.6-sol', reasoningEffort: 'max' },
  checkpoint: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
  final: { model: 'gpt-5.6-sol', reasoningEffort: 'max' },
}
