import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ThreadItem, TurnValue } from '../wire/protocol.js'
import type { TurnCallbacks } from '../wire/client.js'

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

/** Projects one Codex turn into standard replayable DSH assistant events. */
export class SessionTurnProjection {
  readonly callbacks: TurnCallbacks
  private readonly completedItems: ThreadItem[] = []
  private usage: TokenUsage | undefined

  constructor(
    private readonly session: Session,
    private readonly turn: number,
    private readonly step: number,
    private readonly model: string,
  ) {
    this.callbacks = {
      itemCompleted: (item) => this.completedItems.push(item),
      usage: (value) => {
        this.usage = parseUsage(value)
      },
    }
  }

  /** Commit chunks and the final standard assistant message after Codex closes the turn. */
  commit(result: TurnValue): void {
    const items = this.completedItems.length === 0 ? result.items : this.completedItems
    const content = projectAssistantContent(items)
    const sourceEventSeqs: number[] = []
    for (const [index, block] of content.entries()) {
      sourceEventSeqs.push(
        this.session.append('assistant/chunk', {
          turn: this.turn,
          step: this.step,
          chunk: { type: 'block-start', index, blockType: block.type },
        }).seq,
      )
      if (block.type === 'text') {
        sourceEventSeqs.push(
          this.session.append('assistant/chunk', {
            turn: this.turn,
            step: this.step,
            chunk: { type: 'text-delta', index, text: block.text },
          }).seq,
        )
      } else if (block.type === 'reasoning') {
        sourceEventSeqs.push(
          this.session.append('assistant/chunk', {
            turn: this.turn,
            step: this.step,
            chunk: { type: 'reasoning-delta', index, text: block.text },
          }).seq,
        )
      }
      sourceEventSeqs.push(
        this.session.append('assistant/chunk', {
          turn: this.turn,
          step: this.step,
          chunk: { type: 'block-end', index, block },
        }).seq,
      )
    }
    if (this.usage !== undefined) {
      sourceEventSeqs.push(
        this.session.append('assistant/chunk', {
          turn: this.turn,
          step: this.step,
          chunk: { type: 'usage', usage: this.usage },
        }).seq,
      )
    }
    sourceEventSeqs.push(
      this.session.append('assistant/chunk', {
        turn: this.turn,
        step: this.step,
        chunk: {
          type: 'finish',
          reason: finishReason(result),
        },
      }).seq,
    )
    const message = createAssistantMessage({
      content,
      source: { provider: 'codex-app-server', model: this.model },
    })
    this.session.append(
      'assistant/message',
      { turn: this.turn, step: this.step, message, ...(this.usage === undefined ? {} : { usage: this.usage }) },
      { surfaceOp: 'append', sourceEventSeqs },
    )
  }
}

function projectAssistantContent(items: readonly ThreadItem[]): ContentBlock[] {
  const content: ContentBlock[] = []
  for (const item of items) {
    const value = item as Record<string, unknown>
    if (item.type === 'reasoning' && isStringArray(value['summary']) && isStringArray(value['content'])) {
      const reasoning = [...value['summary'], ...value['content']].join('\n')
      if (reasoning !== '') content.push({ type: 'reasoning', text: reasoning })
    }
    if (item.type === 'agentMessage' && typeof value['text'] === 'string' && value['text'] !== '') {
      content.push({ type: 'text', text: value['text'] })
    }
  }
  return content
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
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

function failureOf(result: TurnValue): { message: string; code: string } {
  return {
    message: result.error?.message ?? `Codex turn ended with status ${result.status}`,
    code: 'CODEX_TURN_FAILED',
  }
}

function finishReason(
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
