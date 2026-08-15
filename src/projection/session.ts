import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, TodoItem } from '@deepseek-ai/dsh-session'
import type { TurnCallbacks } from '../wire/client.js'
import type { TurnValue } from '../wire/protocol.js'
import { finishReason, ItemProjection } from './items.js'
import type { TurnEvent } from './items.js'

interface UsageParams {
  tokenUsage?: {
    last?: {
      inputTokens?: number
      cachedInputTokens?: number
      cacheWriteInputTokens?: number
      outputTokens?: number
      reasoningOutputTokens?: number
    }
  }
}

/** Losslessly projects one Codex turn into live, replayable DSH events. */
export class SessionTurnProjection {
  readonly callbacks: TurnCallbacks
  private readonly items: ItemProjection
  private readonly turnEvents: TurnEvent[] = []
  private usage: TokenUsage | undefined
  private committed = false

  constructor(
    private readonly session: Session,
    private readonly turn: number,
    private readonly step: number,
    private readonly model: string,
  ) {
    this.items = new ItemProjection(session, turn, step, model)
    this.callbacks = {
      itemStarted: (item) => this.items.start(item),
      itemCompleted: (item) => this.items.complete(item),
      agentMessageDelta: (itemId, delta) => this.items.outputDelta(itemId, 'agentMessage', 'text', delta),
      reasoningDelta: (itemId, delta) => this.items.outputDelta(itemId, 'reasoning', 'reasoning', delta),
      commandOutputDelta: (itemId, delta) =>
        this.items.recordUpdate(itemId, 'item/commandExecution/outputDelta', { itemId, delta }),
      turnEvent: (method, params) => this.recordTurnEvent(method, params),
      usage: (value) => {
        this.usage = parseUsage(value)
      },
    }
  }

  /** Close open item projections and record terminal accounting after Codex closes the turn. */
  commit(result: TurnValue): void {
    if (!this.beginCommit()) return
    this.items.completeCanonicalItems(result.items)
    this.commitTurnTrace()
    const terminalOwnedByOutput = this.items.close(result, this.usage, this.turnEvents)
    if (!terminalOwnedByOutput) this.commitTerminalChunks(result)
  }

  /** Close a partially observed trajectory when the transport or agent aborts before turn/completed. */
  abort(error: unknown, interrupted: boolean): void {
    const message = error instanceof Error ? error.message : String(error)
    this.commit({
      id: 'unavailable',
      status: interrupted ? 'interrupted' : 'failed',
      items: [],
      error: { message },
    })
  }

  private beginCommit(): boolean {
    if (this.committed) return false
    this.committed = true
    return true
  }

  private commitTerminalChunks(result: TurnValue): void {
    if (this.usage !== undefined) this.appendChunk({ type: 'usage', usage: this.usage })
    this.appendChunk({ type: 'finish', reason: finishReason(result), replayState: this.turnReplayState() })
  }

  private recordTurnEvent(method: string, params: unknown): void {
    const value = asRecord(params)
    const target = targetItemId(value)
    if (target === undefined) this.turnEvents.push({ method, params })
    else this.items.recordUpdate(target, method, params)
    if (method === 'turn/plan/updated') this.projectPlan(value['plan'])
  }

  private projectPlan(plan: unknown): void {
    if (Array.isArray(plan)) this.session.append('todo/write', { todos: projectTodos(plan) })
  }

  private commitTurnTrace(): void {
    const visible = this.turnEvents.flatMap((event) => renderTurnEvent(event))
    if (visible.length === 0) return
    const chunkSeqs = visible.flatMap((block, index) => this.appendCompletedBlock(block, index))
    chunkSeqs.push(this.appendChunk({ type: 'finish', reason: { kind: 'stop' }, replayState: this.turnReplayState() }))
    const message = createAssistantMessage({
      content: visible,
      source: { provider: 'codex-app-server', model: this.model, replayState: this.turnReplayState() },
    })
    this.session.append(
      'assistant/message',
      { turn: this.turn, step: this.step, message },
      { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
    )
  }

  private appendCompletedBlock(block: Extract<ContentBlock, { type: 'text' | 'reasoning' }>, index: number): number[] {
    return [
      this.appendChunk({ type: 'block-start', index, blockType: block.type }),
      this.appendChunk(
        block.type === 'text'
          ? { type: 'text-delta', index, text: block.text }
          : { type: 'reasoning-delta', index, text: block.text },
      ),
      this.appendChunk({ type: 'block-end', index, block }),
    ]
  }

  private appendChunk(chunk: StreamChunk): number {
    return this.session.append('assistant/chunk', { turn: this.turn, step: this.step, chunk }).seq
  }

  private turnReplayState(): { kind: string; events: TurnEvent[] } {
    return { kind: 'codex-turn-events', events: this.turnEvents }
  }
}

function targetItemId(value: Record<string, unknown>): string | undefined {
  if (typeof value['itemId'] === 'string') return value['itemId']
  return typeof value['targetItemId'] === 'string' ? value['targetItemId'] : undefined
}

function projectTodos(plan: unknown[]): TodoItem[] {
  return plan.flatMap((entry) => {
    const value = asRecord(entry)
    if (typeof value['step'] !== 'string') return []
    const status = value['status']
    return [
      {
        content: value['step'],
        status: status === 'inProgress' ? 'in_progress' : status === 'completed' ? 'completed' : 'pending',
      },
    ]
  })
}

function renderTurnEvent(event: TurnEvent): Array<Extract<ContentBlock, { type: 'text' | 'reasoning' }>> {
  const value = asRecord(event.params)
  if (event.method === 'turn/diff/updated' && typeof value['diff'] === 'string' && value['diff'] !== '') {
    return [{ type: 'reasoning', text: `Turn diff\n\n${value['diff']}` }]
  }
  if (event.method === 'turn/plan/updated') {
    const explanation = typeof value['explanation'] === 'string' ? value['explanation'] : ''
    if (explanation !== '') return [{ type: 'reasoning', text: explanation }]
  }
  return []
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function parseUsage(value: unknown): TokenUsage | undefined {
  const last = (value as UsageParams).tokenUsage?.last
  if (last?.inputTokens === undefined || last.outputTokens === undefined) return undefined
  return {
    inputTokens: last.inputTokens,
    outputTokens: last.outputTokens,
    ...(last.cachedInputTokens === undefined ? {} : { cacheReadTokens: last.cachedInputTokens }),
    ...(last.cacheWriteInputTokens === undefined ? {} : { cacheWriteTokens: last.cacheWriteInputTokens }),
    ...(last.reasoningOutputTokens === undefined ? {} : { reasoningTokens: last.reasoningOutputTokens }),
  }
}
