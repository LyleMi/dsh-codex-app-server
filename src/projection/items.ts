import { CallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { JsonValue, Session } from '@deepseek-ai/dsh-session'
import type { ThreadItem, TurnValue } from '../wire/protocol.js'

export interface ItemUpdate {
  method: string
  params: unknown
}

export interface TurnEvent {
  method: string
  params: unknown
}

interface ItemState {
  id: string
  type: string
  started?: ThreadItem
  completed?: ThreadItem
  updates: ItemUpdate[]
  chunkSeqs: number[]
  blockType?: 'text' | 'reasoning'
  streamedText: string
  callSeq?: number
  outputCommitted: boolean
  resultCommitted: boolean
}

const OUTPUT_ITEM_TYPES = new Set(['agentMessage', 'reasoning', 'plan'])

/** Projects correlated App Server items into standard DSH message and tool trajectories. */
export class ItemProjection {
  private readonly states = new Map<string, ItemState>()
  private readonly order: string[] = []

  constructor(
    private readonly session: Session,
    private readonly turn: number,
    private readonly step: number,
    private readonly model: string,
  ) {}

  start(item: ThreadItem): void {
    const state = this.stateForItem(item)
    if (state === undefined) return
    state.started ??= item
    if (OUTPUT_ITEM_TYPES.has(item.type)) this.startOutput(state, outputBlockType(item.type))
    else this.startTool(state, item)
  }

  complete(item: ThreadItem): void {
    const state = this.stateForItem(item)
    if (state === undefined) return
    state.completed = item
    if (OUTPUT_ITEM_TYPES.has(item.type)) {
      this.startOutput(state, outputBlockType(item.type))
      if (!isFinalAnswer(item)) this.commitOutput(state)
      return
    }
    this.startTool(state, state.started ?? item)
    this.commitToolResult(state, item)
  }

  outputDelta(itemId: string, itemType: string, blockType: 'text' | 'reasoning', delta: string): void {
    const state = this.ensureState(itemId, itemType)
    this.startOutput(state, blockType)
    const chunk: StreamChunk =
      blockType === 'text'
        ? { type: 'text-delta', index: 0, text: delta }
        : { type: 'reasoning-delta', index: 0, text: delta }
    state.chunkSeqs.push(this.appendChunk(chunk))
    state.streamedText += delta
  }

  recordUpdate(itemId: string, method: string, params: unknown): void {
    this.ensureState(itemId, inferItemType(method)).updates.push({ method, params })
  }

  completeCanonicalItems(items: readonly ThreadItem[]): void {
    for (const item of items) {
      const id = itemId(item)
      if (id !== undefined && this.states.get(id)?.completed === undefined) this.complete(item)
    }
  }

  close(result: TurnValue, usage: TokenUsage | undefined, turnEvents: readonly TurnEvent[]): boolean {
    const finalOutput = this.findDeferredFinalOutput()
    this.closeStates(finalOutput, result, usage, turnEvents)
    return finalOutput !== undefined
  }

  private closeStates(
    finalOutput: ItemState | undefined,
    result: TurnValue,
    usage: TokenUsage | undefined,
    turnEvents: readonly TurnEvent[],
  ): void {
    for (const id of this.order) {
      const state = this.states.get(id)
      if (state === undefined) continue
      this.closeOutput(state, finalOutput, result, usage, turnEvents)
      if (state.callSeq !== undefined && !state.resultCommitted) this.commitInterruptedResult(state)
    }
  }

  private closeOutput(
    state: ItemState,
    finalOutput: ItemState | undefined,
    result: TurnValue,
    usage: TokenUsage | undefined,
    turnEvents: readonly TurnEvent[],
  ): void {
    if (state.blockType === undefined || state.outputCommitted) return
    const isFinal = state === finalOutput
    this.commitOutput(state, isFinal ? usage : undefined, isFinal ? result : undefined, turnEvents)
  }

  private startOutput(state: ItemState, blockType: 'text' | 'reasoning'): void {
    if (state.blockType !== undefined) return
    state.blockType = blockType
    state.chunkSeqs.push(this.appendChunk({ type: 'block-start', index: 0, blockType }))
  }

  private commitOutput(
    state: ItemState,
    usage?: TokenUsage,
    result?: TurnValue,
    turnEvents: readonly TurnEvent[] = [],
  ): void {
    if (state.outputCommitted) return
    const item = state.completed ?? state.started
    const block = outputBlock(item, state.blockType ?? 'reasoning', state.streamedText)
    this.appendMissingSuffix(state, block)
    state.chunkSeqs.push(this.appendChunk({ type: 'block-end', index: 0, block }))
    if (usage !== undefined) state.chunkSeqs.push(this.appendChunk({ type: 'usage', usage }))
    const replayState = itemReplayState(state, item, result === undefined ? [] : turnEvents)
    state.chunkSeqs.push(
      this.appendChunk({
        type: 'finish',
        reason: result === undefined ? { kind: 'stop' } : finishReason(result),
        replayState,
      }),
    )
    const message = createAssistantMessage({
      content: [block],
      source: { provider: 'codex-app-server', model: this.model, replayState },
    })
    this.session.append(
      'assistant/message',
      { turn: this.turn, step: this.step, message, ...(usage === undefined ? {} : { usage }) },
      { surfaceOp: 'append', sourceEventSeqs: state.chunkSeqs },
    )
    state.outputCommitted = true
  }

  private appendMissingSuffix(state: ItemState, block: Extract<ContentBlock, { type: 'text' | 'reasoning' }>): void {
    const suffix = block.text.startsWith(state.streamedText) ? block.text.slice(state.streamedText.length) : ''
    if (suffix === '') return
    const chunk: StreamChunk =
      block.type === 'text'
        ? { type: 'text-delta', index: 0, text: suffix }
        : { type: 'reasoning-delta', index: 0, text: suffix }
    state.chunkSeqs.push(this.appendChunk(chunk))
  }

  private startTool(state: ItemState, item: ThreadItem): void {
    if (state.callSeq !== undefined) return
    const callId = CallId(state.id)
    const name = `codex.${state.type}`
    const args = JSON.stringify(item)
    const replayState = { kind: 'codex-item-start', item }
    const chunkSeqs = this.appendToolChunks(callId, name, args, replayState)
    const message = createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name, arguments: args }],
      source: { provider: 'codex-app-server', model: this.model, replayState },
    })
    this.session.append(
      'assistant/message',
      { turn: this.turn, step: this.step, message },
      { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
    )
    state.callSeq = this.session.append('tool/call', {
      turn: this.turn,
      step: this.step,
      callId,
      name,
      arguments: args,
    }).seq
  }

  private appendToolChunks(callId: CallId, name: string, args: string, replayState: unknown): number[] {
    return [
      this.appendChunk({ type: 'block-start', index: 0, blockType: 'tool-call' }),
      this.appendChunk({ type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: args }),
      this.appendChunk({
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: callId, name, arguments: args },
      }),
      this.appendChunk({ type: 'finish', reason: { kind: 'tool-calls' }, replayState }),
    ]
  }

  private commitToolResult(state: ItemState, item: ThreadItem): void {
    if (state.resultCommitted || state.callSeq === undefined) return
    const failure = itemFailure(item)
    const message = createToolResultMessage({
      callId: CallId(state.id),
      content: [{ type: 'text', text: renderToolResult(item) }],
      isError: failure !== undefined,
    })
    this.session.append(
      'tool/result',
      {
        turn: this.turn,
        step: this.step,
        message,
        ...(failure === undefined ? {} : { error: failure }),
        meta: traceMeta(item, state.updates),
      },
      { surfaceOp: 'append', sourceEventSeqs: [state.callSeq] },
    )
    state.resultCommitted = true
  }

  private commitInterruptedResult(state: ItemState): void {
    if (state.callSeq === undefined || state.resultCommitted) return
    const item = state.completed ?? state.started ?? { type: state.type, id: state.id }
    const message = createToolResultMessage({
      callId: CallId(state.id),
      content: [{ type: 'text', text: 'Codex turn ended before this item reported completion.' }],
      isError: true,
    })
    this.session.append(
      'tool/result',
      {
        turn: this.turn,
        step: this.step,
        message,
        error: { name: 'CodexItemInterrupted', code: 'CODEX_ITEM_INTERRUPTED' },
        meta: traceMeta(item, state.updates),
      },
      { surfaceOp: 'append', sourceEventSeqs: [state.callSeq] },
    )
    state.resultCommitted = true
  }

  private stateForItem(item: ThreadItem): ItemState | undefined {
    const id = itemId(item)
    if (id === undefined) return undefined
    const state = this.ensureState(id, item.type)
    state.type = item.type
    return state
  }

  private findDeferredFinalOutput(): ItemState | undefined {
    return this.order
      .map((id) => this.states.get(id))
      .findLast((state) => state !== undefined && state.blockType !== undefined && !state.outputCommitted)
  }

  private ensureState(id: string, type: string): ItemState {
    let state = this.states.get(id)
    if (state !== undefined) return state
    state = {
      id,
      type,
      updates: [],
      chunkSeqs: [],
      streamedText: '',
      outputCommitted: false,
      resultCommitted: false,
    }
    this.states.set(id, state)
    this.order.push(id)
    return state
  }

  private appendChunk = (chunk: StreamChunk): number =>
    this.session.append('assistant/chunk', { turn: this.turn, step: this.step, chunk }).seq
}

function itemReplayState(
  state: ItemState,
  item: ThreadItem | undefined,
  turnEvents: readonly TurnEvent[],
): Record<string, unknown> {
  return {
    kind: 'codex-item',
    item: item ?? { type: state.type, id: state.id },
    updates: state.updates,
    ...(turnEvents.length === 0 ? {} : { turnEvents }),
  }
}

function itemId(item: ThreadItem): string | undefined {
  const value = item as Record<string, unknown>
  return typeof value['id'] === 'string' && value['id'] !== '' ? value['id'] : undefined
}

function outputBlockType(type: string): 'text' | 'reasoning' {
  return type === 'agentMessage' ? 'text' : 'reasoning'
}

function outputBlock(
  item: ThreadItem | undefined,
  fallbackType: 'text' | 'reasoning',
  fallbackText: string,
): Extract<ContentBlock, { type: 'text' | 'reasoning' }> {
  const value = asRecord(item)
  if (item?.type === 'agentMessage' && typeof value['text'] === 'string') return { type: 'text', text: value['text'] }
  if (item?.type === 'plan' && typeof value['text'] === 'string') return { type: 'reasoning', text: value['text'] }
  if (item?.type === 'reasoning') {
    const summary = isStringArray(value['summary']) ? value['summary'] : []
    const content = isStringArray(value['content']) ? value['content'] : []
    return { type: 'reasoning', text: [...summary, ...content].join('\n') }
  }
  return { type: fallbackType, text: fallbackText }
}

function isFinalAnswer(item: ThreadItem): boolean {
  const value = item as Record<string, unknown>
  return item.type === 'agentMessage' && value['phase'] === 'final_answer'
}

function renderToolResult(item: ThreadItem): string {
  const value = item as Record<string, unknown>
  if (item.type === 'commandExecution' && typeof value['aggregatedOutput'] === 'string') {
    return value['aggregatedOutput']
  }
  if (item.type === 'fileChange' && Array.isArray(value['changes'])) return JSON.stringify(value['changes'], null, 2)
  if (value['result'] !== undefined && value['result'] !== null) return JSON.stringify(value['result'], null, 2)
  if (value['error'] !== undefined && value['error'] !== null) return JSON.stringify(value['error'], null, 2)
  return JSON.stringify(item, null, 2)
}

function traceMeta(item: unknown, updates: ItemUpdate[]): JsonValue {
  return { provider: 'codex-app-server', item, updates } as unknown as JsonValue
}

function itemFailure(item: ThreadItem): { name: string; code: string } | undefined {
  const value = item as Record<string, unknown>
  const status = value['status']
  if (value['success'] === false || status === 'failed' || status === 'declined' || status === 'interrupted') {
    return { name: 'CodexItemError', code: 'CODEX_ITEM_FAILED' }
  }
  return undefined
}

function inferItemType(method: string): string {
  const match = /^item\/([^/]+)/.exec(method)
  return match?.[1] ?? 'event'
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function failureOf(result: TurnValue): { message: string; code: string } {
  return {
    message: result.error?.message ?? `Codex turn ended with status ${result.status}`,
    code: 'CODEX_TURN_FAILED',
  }
}

export function finishReason(
  result: TurnValue,
):
  | { kind: 'stop' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: { message: string; code: string } }
  | { kind: 'error'; failure: { message: string; code: string } } {
  if (result.status === 'completed') return { kind: 'stop' }
  if (result.error?.codexErrorInfo === 'contextWindowExceeded') return { kind: 'max-tokens' }
  if (result.status === 'interrupted') return { kind: 'aborted', failure: failureOf(result) }
  return { kind: 'error', failure: failureOf(result) }
}
