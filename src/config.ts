import { CodexAppServerError } from './errors.js'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never'
export type UnknownNotificationPolicy = 'ignore' | 'fail-turn'

/** User-configurable Codex App Server process and turn policy. */
export interface Config {
  command?: string
  args?: readonly string[]
  model?: string
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  sandboxMode?: SandboxMode
  approvalPolicy?: ApprovalPolicy
  networkAccess?: boolean
  startupTimeoutMs?: number
  requestIdleTimeoutMs?: number
  interruptGraceMs?: number
  disposeGraceMs?: number
  stderrMaxBytes?: number
  unknownNotificationPolicy?: UnknownNotificationPolicy
  bindingRoot?: string
}

/** Fully validated configuration used by all runtime components. */
export interface ResolvedConfig {
  command: string
  args: readonly string[]
  model?: string
  reasoningEffort?: Config['reasoningEffort']
  sandboxMode: SandboxMode
  approvalPolicy: ApprovalPolicy
  networkAccess?: boolean
  startupTimeoutMs: number
  requestIdleTimeoutMs: number
  interruptGraceMs: number
  disposeGraceMs: number
  stderrMaxBytes: number
  unknownNotificationPolicy: UnknownNotificationPolicy
  bindingRoot?: string
}

const ALLOWED_ARGS = new Set(['--strict-config'])

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new CodexAppServerError('CONFIG_INVALID', `${name} must be a positive safe integer`)
  }
  return resolved
}

/** Validate configuration and reject arguments that can change transport or credentials. */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const command = config.command ?? 'codex'
  if (command.trim() === '') throw new CodexAppServerError('CONFIG_INVALID', 'command must not be empty')
  const args = config.args ?? []
  for (const arg of args) {
    if (!ALLOWED_ARGS.has(arg) && !arg.startsWith('--enable=') && !arg.startsWith('--disable=')) {
      throw new CodexAppServerError(
        'CONFIG_INVALID',
        `unsupported Codex argument ${JSON.stringify(arg)}; transport and task arguments are managed by the plugin`,
      )
    }
  }
  return {
    command,
    args: Object.freeze([...args]),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    sandboxMode: config.sandboxMode ?? 'workspace-write',
    approvalPolicy: config.approvalPolicy ?? 'on-request',
    ...(config.networkAccess === undefined ? {} : { networkAccess: config.networkAccess }),
    startupTimeoutMs: positiveInteger('startupTimeoutMs', config.startupTimeoutMs, 15_000),
    requestIdleTimeoutMs: positiveInteger('requestIdleTimeoutMs', config.requestIdleTimeoutMs, 120_000),
    interruptGraceMs: positiveInteger('interruptGraceMs', config.interruptGraceMs, 3_000),
    disposeGraceMs: positiveInteger('disposeGraceMs', config.disposeGraceMs, 5_000),
    stderrMaxBytes: positiveInteger('stderrMaxBytes', config.stderrMaxBytes, 64 * 1024),
    unknownNotificationPolicy: config.unknownNotificationPolicy ?? 'ignore',
    ...(config.bindingRoot === undefined ? {} : { bindingRoot: config.bindingRoot }),
  }
}
