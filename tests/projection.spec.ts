import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { SessionTurnProjection } from '../src/projection/session.js'

describe('Codex session projection', () => {
  it('projects reasoning, commentary, final text, and disjoint usage without faking DSH tools', () => {
    const session = Session.create(SessionId('projection'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const projection = new SessionTurnProjection(session, 1, 1, 'gpt-5.4')
    projection.callbacks.itemCompleted?.({ type: 'reasoning', id: 'r', summary: ['summary'], content: ['detail'] })
    projection.callbacks.itemCompleted?.({
      type: 'commandExecution',
      id: 'c',
      command: 'pwd',
      cwd: '/workspace',
      status: 'completed',
      aggregatedOutput: '/workspace',
      exitCode: 0,
      durationMs: 5,
    })
    projection.callbacks.itemCompleted?.({ type: 'fileChange', id: 'f', changes: [], status: 'completed' })
    projection.callbacks.itemCompleted?.({
      type: 'agentMessage',
      id: 'commentary',
      text: 'working',
      phase: 'commentary',
    })
    projection.callbacks.itemCompleted?.({
      type: 'agentMessage',
      id: 'final',
      text: 'done',
      phase: 'final_answer',
    })
    projection.callbacks.usage?.({
      tokenUsage: {
        last: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3, reasoningOutputTokens: 2 },
      },
    })
    projection.commit({ id: 'turn-1', status: 'completed', items: [], error: null })

    const message = session.events.find((event) => event.type === 'assistant/message')
    expect(message?.type === 'assistant/message' && message.data.message).toMatchObject({
      content: [
        { type: 'reasoning', text: 'summary\ndetail' },
        { type: 'text', text: 'working' },
        { type: 'text', text: 'done' },
      ],
      source: { provider: 'codex-app-server', model: 'gpt-5.4' },
    })
    expect(message?.type === 'assistant/message' && message.data.usage).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 4,
      reasoningTokens: 2,
    })
    expect(session.events.some((event) => event.type === 'tool/call')).toBe(false)
  })

  it('maps a context-window failure to the standard max-tokens finish reason', () => {
    const session = Session.create(SessionId('context-window'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const projection = new SessionTurnProjection(session, 1, 1, 'gpt-5.4')
    projection.commit({
      id: 'turn-1',
      status: 'failed',
      items: [],
      error: { message: 'context exhausted', codexErrorInfo: 'contextWindowExceeded' },
    })
    expect(session.events.findLast((event) => event.type === 'assistant/chunk')).toMatchObject({
      data: { chunk: { type: 'finish', reason: { kind: 'max-tokens' } } },
    })
  })
})
