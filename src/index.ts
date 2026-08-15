import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import { defaultCodexCommand, resolveConfig } from './config.js'
import type { Config } from './config.js'
import { CodexAgent } from './agent.js'
import { CodexAgentFactory } from './factory.js'
import { CODEX_PROVIDER, CodexModelAdapter, CodexModelCatalog } from './models.js'

export { CodexAgent } from './agent.js'
export { ThreadBindingStore, workspaceFingerprint } from './bindings.js'
export type { DurableThreadBinding } from './bindings.js'
export { defaultCodexCommand, resolveConfig } from './config.js'
export type { Config, ResolvedConfig } from './config.js'
export { CodexAppServerError } from './errors.js'
export { CodexAgentFactory } from './factory.js'
export { CODEX_PROVIDER, CodexModelAdapter, CodexModelCatalog } from './models.js'
export { CodexProcess, buildSpawnSpec } from './process.js'
export { AppServerClient } from './wire/client.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    codexAppServer: CodexAppServerPlugin
  }
}

interface AgentDefaultModelService {
  currentSelection(): ModelSelection
  saveSelection(selection: ModelSelection): Promise<void>
}

/** Cordis plugin that installs the sole DSH AgentFactory provider. */
export class CodexAppServerPlugin extends Service {
  static inject = ['agents', 'sessions', 'llm', 'systemPrompt', 'tools', 'commands', 'agentDefaultModel']

  static Config = z.object({
    command: z.string().default(defaultCodexCommand()),
    args: z.array(z.string()).default([]),
    model: z.string(),
    reasoningEffort: z.string(),
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
    const resolved = resolveConfig(config)
    this.factory = new CodexAgentFactory(ctx, resolved)
    const catalog = new CodexModelCatalog(resolved, process.cwd())
    const models = new CodexModelAdapter(catalog, async (catalogModels) => {
      const defaults = (ctx as Context & { agentDefaultModel: AgentDefaultModelService }).agentDefaultModel
      if (defaults.currentSelection().provider === CODEX_PROVIDER) return
      const model = catalogModels.find((candidate) => candidate.isDefault) ?? catalogModels[0]
      if (model === undefined) throw new Error('Codex App Server returned an empty model catalog')
      await defaults.saveSelection({
        provider: CODEX_PROVIDER,
        model: model.model,
        ...(model.defaultReasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(model.defaultReasoningEffort) }),
      })
    })
    ctx.systemPrompt.variable('cwd', (context) => context.agent?.session.header.cwd)
    ctx.effect(() => () => this.factory.dispose(), 'codexAppServer.factoryLifecycle()')
    ctx.effect(() => ctx.agents.setFactory(this.factory), 'codexAppServer.setFactory()')
    ctx.effect(() => ctx.llm.registerAdapter([CODEX_PROVIDER], models), 'codexAppServer.registerModels()')
    ctx.effect(
      () =>
        ctx.commands.register({
          name: 'compact',
          description: 'Compact the native Codex thread history',
          handler: async (invocation) => {
            if (!(invocation.agent instanceof CodexAgent)) {
              return { kind: 'error', text: 'This compact command requires a Codex App Server agent.' }
            }
            if (invocation.rawInput.trim() !== '') return { kind: 'error', text: 'Usage: /compact (no arguments)' }
            try {
              await invocation.agent.compact(invocation.signal)
              return { kind: 'success', text: 'Compacted the native Codex thread history.' }
            } catch (error: unknown) {
              return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
            }
          },
        }),
      'codexAppServer.registerCompactCommand()',
    )
  }
}

export default CodexAppServerPlugin
