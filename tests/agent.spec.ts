import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexConnectionLauncher } from '../src/agent.js'
import { resolveConfig } from '../src/config.js'
import { CodexAgentFactory } from '../src/factory.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function harness(): Promise<{ ctx: Context; bindingRoot: string }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const bindingRoot = await mkdtemp(join(tmpdir(), 'dsh-codex-bindings-'))
  temporaryRoots.push(bindingRoot)
  return { ctx, bindingRoot }
}

async function installFactory(
  ctx: Context,
  bindingRoot: string,
  launcher: CodexConnectionLauncher,
): Promise<CodexAgentFactory> {
  let factory: CodexAgentFactory | undefined
  await ctx.plugin(
    Object.assign(
      (pluginCtx: Context) => {
        factory = new CodexAgentFactory(pluginCtx, resolveConfig({ bindingRoot }), launcher)
        pluginCtx.agents.setFactory(factory)
      },
      { inject: ['agents', 'sessions'] },
    ),
  )
  if (factory === undefined) throw new Error('factory plugin did not activate')
  return factory
}

function mockLauncher(dispose = vi.fn()): CodexConnectionLauncher {
  return (_config, cwd) => ({
    process: { dispose: () => Promise.resolve(dispose()) },
    client: {
      initialize: () => Promise.resolve({}),
      startThread: () =>
        Promise.resolve({
          thread: { id: 'codex-thread-1', ephemeral: false, cwd, cliVersion: '0.147.0' },
          model: 'gpt-5',
          modelProvider: 'openai',
          cwd,
        }),
      resumeThread: (threadId) =>
        Promise.resolve({
          thread: { id: threadId, ephemeral: false, cwd, cliVersion: '0.147.0' },
          model: 'gpt-5',
          modelProvider: 'openai',
          cwd,
        }),
      startTurn: (_input, callbacks) => {
        const item = { type: 'agentMessage', id: 'message-1', text: 'mock answer', phase: 'final_answer' }
        callbacks?.itemCompleted?.(item)
        callbacks?.usage?.({
          threadId: 'codex-thread-1',
          turnId: 'codex-turn-1',
          tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 } },
        })
        return Promise.resolve({ id: 'codex-turn-1', status: 'completed', items: [item], error: null })
      },
      steer: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      close: () => {},
    },
  })
}

describe('Codex AgentFactory and Agent', () => {
  it('publishes in order, logs a complete turn, and tears down ownership', async () => {
    const { ctx, bindingRoot } = await harness()
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-codex-workspace-'))
    temporaryRoots.push(workspace)
    const disposeProcess = vi.fn()
    const factory = await installFactory(ctx, bindingRoot, mockLauncher(disposeProcess))
    const order: string[] = []
    ctx.on('session/created', () => void order.push('session/created'))
    ctx.on('agent/created', () => void order.push('agent/created'))
    ctx.on('agent/session-start', () => void order.push('agent/session-start'))

    const handle = await ctx.agents.create({
      sessionId: SessionId('agent-turn'),
      meta: { cwd: workspace },
      setup: () => {
        order.push('setup')
        return { commit: () => void order.push('commit') }
      },
    })
    expect(order).toEqual(['setup', 'commit', 'session/created', 'agent/created', 'agent/session-start'])

    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    expect(handle.agent.session.events.map((event) => event.type)).toEqual([
      'agent/inbox/spliced',
      'turn/start',
      'agent/inbox/spliced',
      'step/start',
      'user/message',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    const answer = handle.agent.session.events.find((event) => event.type === 'assistant/message')
    expect(answer?.type === 'assistant/message' && answer.data.message.content).toEqual([
      { type: 'text', text: 'mock answer' },
    ])

    await handle.dispose()
    expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
    expect(ctx.sessions.get(handle.agent.id)).toBeUndefined()
    expect(disposeProcess).toHaveBeenCalledOnce()
    await factory.dispose()
  })

  it('rolls back setup failure without launching or publishing', async () => {
    const { ctx, bindingRoot } = await harness()
    const launch = vi.fn(mockLauncher())
    const factory = await installFactory(ctx, bindingRoot, launch)
    const published = vi.fn()
    ctx.on('session/created', published)

    await expect(
      ctx.agents.create({
        sessionId: SessionId('setup-failure'),
        meta: { cwd: process.cwd() },
        setup: () => {
          throw new Error('setup failed')
        },
      }),
    ).rejects.toThrow('setup failed')
    expect(launch).not.toHaveBeenCalled()
    expect(published).not.toHaveBeenCalled()
    expect(ctx.sessions.get(SessionId('setup-failure'))).toBeUndefined()
    await factory.dispose()
  })
})
