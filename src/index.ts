import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defaultCodexCommand, resolveConfig } from './config.js'
import type { Config } from './config.js'
import { CodexAgentFactory } from './factory.js'

export { CodexAgent } from './agent.js'
export { ThreadBindingStore, workspaceFingerprint } from './bindings.js'
export type { DurableThreadBinding } from './bindings.js'
export { defaultCodexCommand, resolveConfig } from './config.js'
export type { Config, ResolvedConfig } from './config.js'
export { CodexAppServerError } from './errors.js'
export { CodexAgentFactory } from './factory.js'
export { CodexProcess, buildSpawnSpec } from './process.js'
export { AppServerClient } from './wire/client.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    codexAppServer: CodexAppServerPlugin
  }
}

/** Cordis plugin that installs the sole DSH AgentFactory provider. */
export class CodexAppServerPlugin extends Service {
  static inject = ['agents', 'sessions']

  static Config = z.object({
    command: z.string().default(defaultCodexCommand()),
    args: z.array(z.string()).default([]),
    model: z.string(),
    reasoningEffort: z.union(['minimal', 'low', 'medium', 'high', 'xhigh'] as const),
    sandboxMode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('workspace-write'),
    approvalPolicy: z.union(['untrusted', 'on-request', 'never'] as const).default('on-request'),
    networkAccess: z.boolean(),
    startupTimeoutMs: z.number().step(1).min(1).default(15_000),
    requestIdleTimeoutMs: z.number().step(1).min(1).default(120_000),
    turnIdleTimeoutMs: z.number().step(1).min(1).default(120_000),
    interruptGraceMs: z.number().step(1).min(1).default(3_000),
    disposeGraceMs: z.number().step(1).min(1).default(5_000),
    stderrMaxBytes: z.number().step(1).min(1).default(65_536),
    protocolMaxBytes: z.number().step(1).min(1).default(8_388_608),
    unknownNotificationPolicy: z.union(['ignore', 'fail-turn'] as const).default('ignore'),
    bindingRoot: z.string(),
  }) as z<Config>

  readonly factory: CodexAgentFactory

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'codexAppServer')
    this.factory = new CodexAgentFactory(ctx, resolveConfig(config))
    ctx.effect(() => () => this.factory.dispose(), 'codexAppServer.factoryLifecycle()')
    ctx.effect(() => ctx.agents.setFactory(this.factory), 'codexAppServer.setFactory()')
  }
}

export default CodexAppServerPlugin
