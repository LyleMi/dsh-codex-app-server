import { Inbox, agentEvents, assembleContextFor, emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type {
  Agent,
  AgentCancelCause,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
} from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type AttachmentStore from '@deepseek-ai/dsh-attachment'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.js'
import { handleCodexInteraction } from './interaction.js'
import { SessionTurnProjection } from './projection/session.js'
import { RuntimeContextProjection } from './projection/runtime-context.js'
import { CodexRuntime } from './runtime.js'
import type { CodexConnectionLauncher } from './runtime.js'
import { CODEX_PROVIDER } from './models.js'
import type { CodexTurnSelection } from './wire/client.js'
import type { TurnInput } from './wire/protocol.js'
import { assembleCodexBridge, executeDshDynamicTool } from './bridge.js'

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
  private readonly events: ReturnType<typeof agentEvents>
  private readonly configuredReasoningEffort: string | undefined
  private readonly runtimeContext: RuntimeContextProjection

  private readonly hostCtx: Context
  readonly id: SessionId
  readonly session: Session

  constructor(init: CodexAgentInit) {
    this.hostCtx = init.hostCtx
    this.id = init.id
    this.session = init.session
    const initialModel =
      init.config.model ?? (init.options.provider === CODEX_PROVIDER ? init.options.model : undefined)
    this.configuredReasoningEffort = init.config.reasoningEffort
    this.options = { provider: CODEX_PROVIDER, ...(initialModel === undefined ? {} : { model: initialModel }) }
    this.inbox = new Inbox(this.session, {
      inserted: (message) => emitAgentEvent(this.hostCtx, this, 'agent/inbox/inserted', { message }),
      discarded: (message) => emitAgentEvent(this.hostCtx, this, 'agent/inbox/discarded', { message }),
      claimed: (message, turn) => emitAgentEvent(this.hostCtx, this, 'agent/inbox/claimed', { message, turn }),
    })
    const lastTurn = this.session.events.findLast((event) => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(this.hostCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.events = agentEvents(this.hostCtx, this)
    this.runtimeContext = new RuntimeContextProjection(this.ctx, this.session)
    this.runtime = createRuntime(init, initialModel, this, () =>
      this.phase.kind === 'idle' ? undefined : this.phase.abort.signal,
    )
  }

  get status(): AgentStatus {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  /** Start the child, handshake, and create or resume its exact thread. */
  async connect(resumeThreadId?: string) {
    const selection = await resolveSelection({
      agent: this,
      hostCtx: this.hostCtx,
      events: this.events,
      fallbackModel: this.options.model,
      configuredReasoningEffort: this.configuredReasoningEffort,
      turn: 0,
      step: 0,
      signal: new AbortController().signal,
      allowForeignDefault: true,
    })
    const signal = new AbortController().signal
    const bridge = await assembleCodexBridge(this.hostCtx, this, signal)
    return this.runtime.connect(
      resumeThreadId,
      resumeThreadId === undefined ? renderSeedContext(this.session) : undefined,
      selection,
      bridge,
    )
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
    void renderMessages(this.hostCtx, claimed, this.phase.abort.signal)
      .then((input) => this.runtime.steer(input))
      .catch((error) => reportLiveFailure(this, this.hostCtx, this.phase, error))
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
    void this.runtime.interrupt().catch((error) => reportLiveFailure(this, this.hostCtx, this.phase, error))
  }

  async whenIdle(): Promise<void> {
    let observed: Promise<void>
    do {
      await (observed = this.activityDone)
    } while (observed !== this.activityDone)
  }

  compact(signal: AbortSignal): Promise<void> {
    return this.runMaintenance(async (maintenanceSignal) => {
      const result = await this.runtime.compact(AbortSignal.any([signal, maintenanceSignal]))
      if (result.status !== 'completed') throw new Error(`Codex thread compaction ${result.status}`)
    })
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
      reportLiveFailure(this, this.hostCtx, this.phase, error)
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
    const claimed = this.inbox.claim('next-turn', turn)
    if (claimed.length === 0) {
      this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      return
    }
    const step = 1
    let ending: TurnEndReason = { kind: 'completed' }
    let projection: SessionTurnProjection | undefined
    try {
      const selection = await resolveSelection({
        agent: this,
        hostCtx: this.hostCtx,
        events: this.events,
        fallbackModel: this.options.model ?? connectedModel(this.runtime),
        configuredReasoningEffort: this.configuredReasoningEffort,
        turn,
        step,
        signal: phase.abort.signal,
        allowForeignDefault: false,
      })
      const bridge = await assembleCodexBridge(this.hostCtx, this, phase.abort.signal)
      const context = this.runtimeContext.project(bridge.contextText, bridge.contextSections)
      const decision = await this.events.waterfall(
        'agent/pre-step',
        { messages: claimed, turn, step, signal: phase.abort.signal },
        (): Promise<PreStepDecision> =>
          Promise.resolve({ kind: 'enter', messages: context === undefined ? claimed : [...claimed, context] }),
      )
      phase.abort.signal.throwIfAborted()
      if (decision.kind === 'reject') {
        ending = { kind: 'blocked' }
        return
      }
      if (decision.messages.length === 0) return
      this.session.append('step/start', { turn, step })
      for (const message of decision.messages) this.session.append('user/message', message, { surfaceOp: 'append' })
      projection = new SessionTurnProjection(this.session, turn, step, selection?.model ?? binding.model)
      const input = await renderMessages(this.hostCtx, decision.messages, phase.abort.signal)
      const result = await this.runtime.startTurn(input, projection.callbacks, selection, bridge)
      projection.commit(result)
      ending = turnEnding(result.status, result.error?.message, result.error?.codexErrorInfo, phase.cause)
    } catch (error: unknown) {
      projection?.abort(error, phase.abort.signal.aborted)
      ending = phase.abort.signal.aborted
        ? { kind: 'aborted', reason: phase.cause ?? { kind: 'user' } }
        : {
            kind: 'error',
            error: { message: error instanceof Error ? error.message : String(error), code: 'CODEX_ERROR' },
          }
      throw error
    } finally {
      if (this.session.events.findLast((event) => event.type === 'step/start')?.data.turn === turn) {
        this.session.append('step/end', { turn, step })
      }
      this.session.append('turn/end', { turn, reason: ending })
    }
  }
}

function reportLiveFailure(agent: Agent, ctx: Context, phase: Phase, error: unknown): void {
  const turn = phase.kind === 'running' ? phase.turn : phase.lastTurn
  emitAgentEvent(ctx, agent, 'agent/error', { turn, step: phase.kind === 'running' ? 1 : 0, error })
}

function createRuntime(
  init: CodexAgentInit,
  initialModel: string | undefined,
  agent: CodexAgent,
  activeSignal: () => AbortSignal | undefined,
): CodexRuntime {
  return new CodexRuntime(
    { ...init.config, ...(initialModel === undefined ? {} : { model: initialModel }) },
    init.session.header.cwd ?? process.cwd(),
    {
      ...(init.launchConnection === undefined ? {} : { launcher: init.launchConnection }),
      serverRequestHandler: (request) => {
        const signal = activeSignal()
        if (request.method !== 'item/tool/call') return handleCodexInteraction(init.hostCtx, agent, request, signal)
        if (signal === undefined) return Promise.reject(new Error('DSH dynamic tool call arrived outside active work'))
        return executeDshDynamicTool(init.hostCtx, agent, request, signal)
      },
      protocolDiagnostic: (diagnostic) => {
        init.hostCtx.logger('dsh-codex-app-server')[diagnostic.level]('%s: %s', diagnostic.method, diagnostic.message)
      },
    },
  )
}

interface SelectionRequest {
  agent: Agent
  hostCtx: Context
  events: ReturnType<typeof agentEvents>
  fallbackModel: string | undefined
  configuredReasoningEffort: string | undefined
  turn: number
  step: number
  signal: AbortSignal
  allowForeignDefault: boolean
}

async function resolveSelection(request: SelectionRequest): Promise<CodexTurnSelection | undefined> {
  const systemPrompt = request.hostCtx.get('systemPrompt')
  if (systemPrompt !== undefined) await systemPrompt.assemble(assembleContextFor(request.agent, request.signal))
  const placeholder = request.fallbackModel ?? '__codex_account_default__'
  const base: LlmCallConfig = {
    provider: CODEX_PROVIDER,
    model: placeholder,
    ...(request.configuredReasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(request.configuredReasoningEffort) }),
  }
  const selected = await request.events.waterfall(
    'agent/request',
    { turn: request.turn, step: request.step, signal: request.signal },
    () => Promise.resolve(base),
  )
  if (selected.provider !== CODEX_PROVIDER) {
    if (request.allowForeignDefault) return undefined
    throw new Error(
      `Codex-only profile cannot route provider ${JSON.stringify(selected.provider)}; select a ${JSON.stringify(CODEX_PROVIDER)} model for this session`,
    )
  }
  if (selected.model === placeholder && request.fallbackModel === undefined) return undefined
  return {
    model: selected.model,
    ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
  }
}

function connectedModel(runtime: CodexRuntime): string | undefined {
  try {
    return runtime.binding.model
  } catch {
    return undefined
  }
}

async function renderMessages(
  ctx: Context,
  messages: readonly UserMessage[],
  signal?: AbortSignal,
): Promise<TurnInput[]> {
  const input: TurnInput[] = []
  for (const [messageIndex, message] of messages.entries()) {
    if (messageIndex > 0) input.push({ type: 'text', text: '\n\n', text_elements: [] })
    for (const [blockIndex, block] of message.content.entries()) {
      if (blockIndex > 0) input.push({ type: 'text', text: '\n', text_elements: [] })
      input.push(await renderBlock(ctx, block, signal))
    }
  }
  return input
}

async function renderBlock(ctx: Context, block: ContentBlock, signal?: AbortSignal): Promise<TurnInput> {
  if (block.type === 'text' || block.type === 'reasoning') {
    return { type: 'text', text: block.text, text_elements: [] }
  }
  if (block.type === 'image') {
    const attachments: AttachmentStore | undefined = ctx.get('attachments')
    if (attachments === undefined) throw new Error('cannot send DSH image input without an attachment store')
    const stored = await attachments.readImage(block.attachment, signal)
    const encoded = Buffer.from(stored.data).toString('base64')
    return { type: 'image', url: `data:${stored.ref.mediaType};base64,${encoded}` }
  }
  throw new Error(`Codex App Server provider does not accept DSH ${block.type} input blocks`)
}

const FORK_CONTEXT_MAX_BYTES = 64 * 1024

function renderSeedContext(session: Session): string | undefined {
  if (session.firstLiveSeq === 0) return undefined
  const transcript = session
    .deriveMessages()
    .flatMap((message) => {
      const text = message.content
        .flatMap((block) => (block.type === 'text' || block.type === 'reasoning' ? [block.text] : []))
        .join('\n')
      return text === '' ? [] : [`[${message.role}]\n${text}`]
    })
    .join('\n\n')
  if (transcript === '') return undefined
  const heading = 'Inherited DSH session context (bounded; earlier content may be omitted):\n'
  const budget = FORK_CONTEXT_MAX_BYTES - Buffer.byteLength(heading)
  const bytes = Buffer.from(transcript)
  const bounded = bytes.length <= budget ? transcript : bytes.subarray(bytes.length - budget).toString('utf8')
  return `${heading}${bounded}`
}

function turnEnding(
  status: string,
  message: string | undefined,
  codexErrorInfo: string | null | undefined,
  cause: AgentCancelCause | undefined,
): TurnEndReason {
  if (status === 'completed') return { kind: 'completed' }
  if (status === 'interrupted') return { kind: 'aborted', reason: cause ?? { kind: 'user' } }
  if (codexErrorInfo === 'contextWindowExceeded') return { kind: 'max-tokens' }
  return { kind: 'error', error: { message: message ?? `Codex turn ${status}`, code: 'CODEX_TURN_FAILED' } }
}
