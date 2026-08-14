import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type {
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
  SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import { SessionPreparation } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { Context } from '@deepseek-ai/cordis'
import { CodexAgent } from './agent.js'
import type { CodexConnectionLauncher } from './agent.js'
import { ThreadBindingStore, workspaceFingerprint } from './bindings.js'
import type { ResolvedConfig } from './config.js'

interface PreparedLifecycle {
  agent: CodexAgent
  signal: AbortSignal
  publish(source: SessionStartSource): AgentHandle
  dispose(ownerTriggered?: boolean): Promise<void>
}

interface SetupTransaction {
  ownerCtx: Context
  preparation: SessionPreparation
  id: SessionId
  options: AgentOptions
  setup?: AgentSetup
  callerSignal?: AbortSignal
  source: SessionStartSource
}

/** Public AgentFactory implementation and structural owner of every Codex child. */
export class CodexAgentFactory implements AgentFactory {
  private accepting = true
  private readonly shutdown = new AbortController()
  private readonly live = new Set<(ownerTriggered?: boolean) => Promise<void>>()
  private readonly bindings: ThreadBindingStore

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly launchConnection?: CodexConnectionLauncher,
  ) {
    this.bindings = new ThreadBindingStore(config.bindingRoot)
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    this.assertActive(ownerCtx)
    const preparation = SessionPreparation.create(
      this.ctx.sessions.prepare(options.sessionId, {
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(options.meta === undefined ? {} : { meta: options.meta }),
      }),
    )
    return this.setupAndPublish({
      ownerCtx,
      preparation,
      id: options.sessionId,
      options: options.agentOptions ?? {},
      ...(options.setup === undefined ? {} : { setup: options.setup }),
      ...(options.signal === undefined ? {} : { callerSignal: options.signal }),
      source: 'startup',
    })
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    this.assertActive(ownerCtx)
    const persistence: SessionPersistence | undefined = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured')
    }
    const signal = AbortSignal.any([this.shutdown.signal, ...(options.signal === undefined ? [] : [options.signal])])
    const preparation = await persistence.prepare(options.resumeSessionId, signal)
    return this.setupAndPublish({
      ownerCtx,
      preparation,
      id: options.resumeSessionId,
      options: options.agentOptions ?? {},
      ...(options.setup === undefined ? {} : { setup: options.setup }),
      ...(options.signal === undefined ? {} : { callerSignal: options.signal }),
      source: 'resume',
    })
  }

  /** Stop admission, cancel creation, and drain every process owned by this factory. */
  async dispose(): Promise<void> {
    if (!this.accepting) return
    this.accepting = false
    this.shutdown.abort(new Error('Codex AgentFactory is unloading'))
    await Promise.all([...this.live].map((dispose) => dispose()))
  }

  private async setupAndPublish(transaction: SetupTransaction): Promise<AgentHandle> {
    const { ownerCtx, preparation, id, options } = transaction
    const lifecycle = this.prepare(ownerCtx, id, options, preparation.session)
    try {
      return await this.completeSetup(transaction, lifecycle)
    } catch (error: unknown) {
      await lifecycle.dispose()
      throw error
    } finally {
      preparation[Symbol.dispose]()
    }
  }

  private async completeSetup(transaction: SetupTransaction, lifecycle: PreparedLifecycle): Promise<AgentHandle> {
    const { preparation, id, setup, callerSignal, source } = transaction
    const signal = AbortSignal.any([
      lifecycle.signal,
      this.shutdown.signal,
      ...(callerSignal === undefined ? [] : [callerSignal]),
    ])
    const commit = await raceAbort(setup?.(lifecycle.agent.ctx), signal)
    commit?.commit()
    const wroteBinding = await this.connectThread(lifecycle.agent, preparation, id, source)
    try {
      return lifecycle.publish(source)
    } catch (error: unknown) {
      if (wroteBinding) await this.bindings.remove(id)
      throw error
    }
  }

  private async connectThread(
    agent: CodexAgent,
    preparation: SessionPreparation,
    id: SessionId,
    source: SessionStartSource,
  ): Promise<boolean> {
    const cwd = preparation.session.header.cwd ?? process.cwd()
    if (source === 'resume') {
      const durable = await this.bindings.read(id, cwd)
      await agent.connect(durable.threadId)
      return false
    }
    const binding = await agent.connect()
    await this.bindings.write({
      version: 1,
      sessionId: id,
      threadId: binding.thread.id,
      cwdFingerprint: workspaceFingerprint(cwd),
      cliVersion: binding.thread.cliVersion,
      ephemeral: false,
    })
    return true
  }

  private prepare(
    ownerCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: SessionPreparation['session'],
  ): PreparedLifecycle {
    const agent = new CodexAgent({
      hostCtx: this.ctx,
      id,
      options,
      session,
      config: this.config,
      ...(this.launchConnection === undefined ? {} : { launchConnection: this.launchConnection }),
    })
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let published = false
    let disposing: Promise<void> | undefined
    let ownerTriggered = false
    let unfollowOwner: (() => Promise<void> | void) | undefined
    const ownerAbort = new AbortController()

    const dispose = async (fromOwner = false): Promise<void> => {
      ownerTriggered ||= fromOwner
      if (disposing !== undefined) return disposing
      disposing = (async () => {
        try {
          await agent.shutdown()
          await agent.scope.dispose()
        } finally {
          try {
            detachAgent?.()
            detachSession?.()
          } finally {
            this.live.delete(dispose)
            if (!ownerTriggered) await unfollowOwner?.()
          }
        }
      })()
      return disposing
    }
    this.live.add(dispose)
    try {
      unfollowOwner = ownerCtx.effect(
        () => () => {
          if (disposing !== undefined) return
          ownerAbort.abort(new Error(`agent ${id} owner disposed`))
          return dispose(true)
        },
        `codexAgent.lifecycle(${id})`,
      )
    } catch (error: unknown) {
      this.live.delete(dispose)
      void agent.scope.dispose()
      throw error
    }

    return {
      agent,
      signal: ownerAbort.signal,
      publish: (source) => {
        if (published) throw new Error(`agent ${id} is already published`)
        this.assertActive(ownerCtx)
        detachSession = agent.ctx.sessions.enter(session)
        detachAgent = this.ctx.agents.enter(agent, ownerCtx.agent)
        agent.ctx.sessions.announce(session)
        this.ctx.agents.announce(agent)
        emitAgentEvent(this.ctx, agent, 'agent/session-start', { source })
        published = true
        return { agent, dispose }
      },
      dispose,
    }
  }

  private assertActive(ownerCtx: Context): void {
    ownerCtx.fiber.assertActive()
    if (!this.accepting || this.shutdown.signal.aborted) throw new Error('Codex AgentFactory is not active')
  }
}

async function raceAbort<T>(operation: PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const listener = (): void => aborted.reject(signal.reason)
  signal.addEventListener('abort', listener, { once: true })
  try {
    return await Promise.race([Promise.resolve(operation), aborted.promise])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}
