import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { SessionTurnProjection } from '../src/projection/session.js'

describe('Codex session projection', () => {
  it('projects text plus Codex-owned tool trajectories with durable raw metadata', () => {
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

    const messages = session.events.filter((event) => event.type === 'assistant/message')
    expect(messages.map((event) => event.data.message.content)).toEqual([
      [{ type: 'reasoning', text: 'summary\ndetail' }],
      [expect.objectContaining({ type: 'tool-call', name: 'codex.commandExecution' })],
      [expect.objectContaining({ type: 'tool-call', name: 'codex.fileChange' })],
      [{ type: 'text', text: 'working' }],
      [{ type: 'text', text: 'done' }],
    ])
    const finalMessage = messages.at(-1)
    expect(finalMessage?.data.usage).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 4,
      reasoningTokens: 2,
    })
    expect(session.events.filter((event) => event.type === 'tool/call')).toHaveLength(2)
    const results = session.events.filter((event) => event.type === 'tool/result')
    expect(results).toHaveLength(2)
    expect(results[0]?.data.meta).toMatchObject({
      provider: 'codex-app-server',
      item: { type: 'commandExecution', command: 'pwd', exitCode: 0 },
    })

    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const replay = Session.create(SessionId('projection-replay'), session.events)
    expect(replay.events.filter((event) => event.type === 'tool/call')).toHaveLength(2)
    expect(replay.events.filter((event) => event.type === 'tool/result')).toHaveLength(2)
    expect(replay.deriveMessages().map((item) => item.content.map((block) => block.type))).toEqual([
      ['reasoning'],
      ['tool-call'],
      ['tool-result'],
      ['tool-call'],
      ['tool-result'],
      ['text'],
      ['text'],
    ])
  })

  it('publishes assistant deltas before item and turn completion', () => {
    const session = Session.create(SessionId('live-stream'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const projection = new SessionTurnProjection(session, 1, 1, 'gpt-5.4')

    projection.callbacks.itemStarted?.({ type: 'agentMessage', id: 'answer', text: '', phase: 'final_answer' })
    projection.callbacks.agentMessageDelta?.('answer', 'hel')
    projection.callbacks.agentMessageDelta?.('answer', 'lo')

    expect(session.events.slice(-3).map((event) => event.type)).toEqual([
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
    ])
    expect(session.events.filter((event) => event.type === 'assistant/chunk').map((event) => event.data.chunk)).toEqual(
      [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'hel' },
        { type: 'text-delta', index: 0, text: 'lo' },
      ],
    )
    expect(session.events.some((event) => event.type === 'assistant/message')).toBe(false)

    projection.callbacks.itemCompleted?.({
      type: 'agentMessage',
      id: 'answer',
      text: 'hello!',
      phase: 'final_answer',
    })
    projection.commit({ id: 'turn-1', status: 'completed', items: [], error: null })

    const message = session.events.find((event) => event.type === 'assistant/message')
    expect(message?.type === 'assistant/message' && message.data.message.content).toEqual([
      { type: 'text', text: 'hello!' },
    ])
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

  it('projects plan state, turn diffs, and intermediate item updates', () => {
    const session = Session.create(SessionId('turn-state'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const projection = new SessionTurnProjection(session, 1, 1, 'gpt-5.4')
    projection.callbacks.itemStarted?.({
      type: 'mcpToolCall',
      id: 'mcp',
      server: 'repo',
      tool: 'lookup',
      status: 'inProgress',
      arguments: { q: 'value' },
    })
    projection.callbacks.turnEvent?.('item/mcpToolCall/progress', {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'mcp',
      message: 'halfway',
    })
    projection.callbacks.turnEvent?.('turn/plan/updated', {
      threadId: 'thread',
      turnId: 'turn',
      explanation: 'Inspect, then change.',
      plan: [
        { step: 'Inspect', status: 'completed' },
        { step: 'Change', status: 'inProgress' },
      ],
    })
    projection.callbacks.turnEvent?.('turn/diff/updated', {
      threadId: 'thread',
      turnId: 'turn',
      diff: '--- a/file\n+++ b/file',
    })
    projection.callbacks.itemCompleted?.({
      type: 'mcpToolCall',
      id: 'mcp',
      server: 'repo',
      tool: 'lookup',
      status: 'completed',
      result: { value: 1 },
    })
    projection.commit({ id: 'turn-1', status: 'completed', items: [], error: null })

    expect(session.events.findLast((event) => event.type === 'todo/write')).toMatchObject({
      data: {
        todos: [
          { content: 'Inspect', status: 'completed' },
          { content: 'Change', status: 'in_progress' },
        ],
      },
    })
    const result = session.events.find((event) => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.meta).toMatchObject({
      item: { type: 'mcpToolCall', result: { value: 1 } },
      updates: [{ method: 'item/mcpToolCall/progress', params: { message: 'halfway' } }],
    })
    const trace = session.events.findLast((event) => event.type === 'assistant/message')
    expect(trace?.type === 'assistant/message' && trace.data.message.content).toEqual([
      { type: 'reasoning', text: 'Inspect, then change.' },
      { type: 'reasoning', text: 'Turn diff\n\n--- a/file\n+++ b/file' },
    ])
  })

  it('closes partially observed tool and output trajectories on transport failure', () => {
    const session = Session.create(SessionId('failed-trajectory'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const projection = new SessionTurnProjection(session, 1, 1, 'gpt-5.4')
    projection.callbacks.itemStarted?.({
      type: 'commandExecution',
      id: 'command',
      command: 'long-running',
      cwd: '/workspace',
      status: 'inProgress',
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    })
    projection.callbacks.reasoningDelta?.('reasoning', 'partial', 'content')

    projection.abort(new Error('connection lost'), false)

    expect(session.events.find((event) => event.type === 'tool/result')).toMatchObject({
      data: { error: { code: 'CODEX_ITEM_INTERRUPTED' } },
    })
    expect(session.events.findLast((event) => event.type === 'assistant/chunk')).toMatchObject({
      data: { chunk: { type: 'finish', reason: { kind: 'error' } } },
    })
    const count = session.events.length
    projection.abort(new Error('again'), false)
    expect(session.events).toHaveLength(count)
  })
})
