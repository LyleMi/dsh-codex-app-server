import { Inbox, emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type {
  Agent,
  AgentCancelCause,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.js'
import { SessionTurnProjection } from './projection/session.js'
import { CodexRuntime } from './runtime.js'
import type { CodexConnectionLauncher } from './runtime.js'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; lastTurn: number; abort: AbortController; wakeRequested: boolean }
  | { kind: 'running'; turn: number; abort: AbortController; wakeRequested: boolean; cause?: AgentCancelCause }

export type { CodexConnection, CodexConnectionLauncher } from './runtime.js'

export interface CodexAgentInit {
  hostCtx: Context
  id: SessionId
  options: AgentOptions
  session: Session
  config: ResolvedConfig
  launchConnection?: CodexConnectionLauncher
}

/** A DSH Agent driven by one official Codex App Server process and thread. */
export class CodexAgent implements Agent {
  readonly inbox: Inbox
  readonly scope: Scope
  readonly ctx: Context
  readonly options: AgentOptions
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  private readonly runtime: CodexRuntime

  private readonly hostCtx: Context
  readonly id: SessionId
  readonly session: Session

  constructor(init: CodexAgentInit) {
    this.hostCtx = init.hostCtx
    this.id = init.id
    this.session = init.session
    const options = init.options
    this.options = { provider: 'codex-app-server', ...(options.model === undefined ? {} : { model: options.model }) }
    this.inbox = new Inbox(this.session, {
      inserted: (message) => emitAgentEvent(this.hostCtx, this, 'agent/inbox/inserted', { message }),
      discarded: (message) => emitAgentEvent(this.hostCtx, this, 'agent/inbox/discarded', { message }),
      claimed: (message, turn) => emitAgentEvent(this.hostCtx, this, 'agent/inbox/claimed', { message, turn }),
    })
    const lastTurn = this.session.events.findLast((event) => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(this.hostCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.runtime = new CodexRuntime(
      init.config,
      this.session.header.cwd ?? process.cwd(),
      this.options,
      init.launchConnection,
    )
  }

  get status(): AgentStatus {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  get threadBinding() {
    return this.runtime.binding
  }

  /** Start the child, handshake, and create or resume its exact thread. */
  connect(resumeThreadId?: string) {
    return this.runtime.connect(resumeThreadId)
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    const targetAfterCancel =
      wakeup && this.phase.kind === 'running' && this.phase.abort.signal.aborted ? 'next-turn' : target
    this.inbox.splice(targetAfterCancel, Infinity, 0, [message])
    if (wakeup) this.wake()
  }

  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  steer(message: UserMessage): void {
    if (this.phase.kind !== 'running') {
      this.send(message, 'next-step', true)
      return
    }
    this.inbox.append('next-step', message)
    const claimed = this.inbox.claim('next-step', this.phase.turn)
    for (const item of claimed) this.session.append('user/message', item, { surfaceOp: 'append' })
    const prompt = renderMessages(claimed)
    void this.runtime.steer(prompt).catch((error) => this.failLive(error))
  }

  inject(message: UserMessage): void {
    this.send(message, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind === 'idle') return
    this.phase.abort.abort(cause)
    if (this.phase.kind === 'running') this.phase.cause ??= cause
    void this.runtime.interrupt().catch((error) => this.failLive(error))
  }

  async whenIdle(): Promise<void> {
    let observed: Promise<void>
    do {
      await (observed = this.activityDone)
    } while (observed !== this.activityDone)
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const phase: Phase = {
      kind: 'maintenance',
      lastTurn: this.phase.lastTurn,
      abort: new AbortController(),
      wakeRequested: false,
    }
    this.setPhase(phase)
    this.activityDone = done.promise
    return task(phase.abort.signal).finally(() => {
      this.setPhase({ kind: 'idle', lastTurn: phase.lastTurn })
      if (phase.wakeRequested && this.inbox.hasPending) this.wake()
      done.resolve()
    })
  }

  /** Stop requests and the process; the factory disposes scope and registries afterward. */
  async shutdown(): Promise<void> {
    this.cancel({ kind: 'disposed' })
    await this.runtime.shutdown()
    await this.whenIdle()
  }

  private setPhase(next: Phase): void {
    const previous = this.status
    this.phase = next
    if (previous !== this.status) emitAgentEvent(this.hostCtx, this, 'agent/status', { status: this.status })
  }

  private wake(): void {
    if (this.phase.kind !== 'idle') {
      if (this.phase.kind === 'maintenance' || this.phase.abort.signal.aborted) this.phase.wakeRequested = true
      return
    }
    const done = Promise.withResolvers<void>()
    this.activityDone = done.promise
    this.setPhase({ kind: 'running', turn: this.phase.lastTurn, abort: new AbortController(), wakeRequested: false })
    void this.hostCtx.agents.withInitiator(this, () => this.drive()).then(done.resolve, done.reject)
  }

  private async drive(): Promise<void> {
    try {
      while (this.inbox.hasPending && this.phase.kind === 'running') await this.runTurn(this.phase)
    } catch (error: unknown) {
      this.failLive(error)
    } finally {
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wake()
      }
    }
  }

  private async runTurn(phase: Extract<Phase, { kind: 'running' }>): Promise<void> {
    const binding = this.runtime.binding
    const turn = phase.turn + 1
    this.session.append('turn/start', { turn })
    phase.turn = turn
    const messages = this.inbox.claim('next-turn', turn)
    if (messages.length === 0) {
      this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      return
    }
    const step = 1
    this.session.append('step/start', { turn, step })
    let ending: TurnEndReason = { kind: 'completed' }
    try {
      for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
      const projection = new SessionTurnProjection(this.session, turn, step, binding.model)
      const result = await this.runtime.startTurn(renderMessages(messages), projection.callbacks)
      projection.commit(result)
      ending = turnEnding(result.status, result.error?.message, phase.cause)
    } catch (error: unknown) {
      ending = phase.abort.signal.aborted
        ? { kind: 'aborted', reason: phase.cause ?? { kind: 'user' } }
        : {
            kind: 'error',
            error: { message: error instanceof Error ? error.message : String(error), code: 'CODEX_ERROR' },
          }
      throw error
    } finally {
      this.session.append('step/end', { turn, step })
      this.session.append('turn/end', { turn, reason: ending })
    }
  }

  private failLive(error: unknown): void {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    emitAgentEvent(this.hostCtx, this, 'agent/error', { turn, step: this.phase.kind === 'running' ? 1 : 0, error })
  }
}

function renderMessages(messages: readonly UserMessage[]): string {
  return messages.map((message) => message.content.map(renderBlock).join('\n')).join('\n\n')
}

function renderBlock(block: ContentBlock): string {
  if (block.type === 'text' || block.type === 'reasoning') return block.text
  throw new Error(`Codex App Server provider does not yet accept DSH ${block.type} input blocks`)
}

function turnEnding(status: string, message: string | undefined, cause: AgentCancelCause | undefined): TurnEndReason {
  if (status === 'completed') return { kind: 'completed' }
  if (status === 'interrupted') return { kind: 'aborted', reason: cause ?? { kind: 'user' } }
  return { kind: 'error', error: { message: message ?? `Codex turn ${status}`, code: 'CODEX_TURN_FAILED' } }
}
