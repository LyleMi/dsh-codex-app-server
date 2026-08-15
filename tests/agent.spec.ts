import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionPreparation } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexConnection, CodexConnectionLauncher } from '../src/agent.js'
import { ThreadBindingStore } from '../src/bindings.js'
import { resolveConfig } from '../src/config.js'
import type { Config } from '../src/config.js'
import { CodexAppServerError } from '../src/errors.js'
import { CodexAgentFactory } from '../src/factory.js'
import type { TurnInput } from '../src/wire/protocol.js'

const temporaryRoots: string[] = []

function renderedText(input: readonly TurnInput[]): string {
  return input.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('')
}

class TestAttachments extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1_000,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 1_000,
    maxImagePixels: 1_000,
    mediaTypes: ['image/png'],
  }

  validateImage(): Promise<void> {
    return Promise.resolve()
  }

  saveImage(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }

  readImage() {
    return Promise.resolve({
      ref: { attachmentId: AttachmentId('image-1'), mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 },
      data: Uint8Array.from([1, 2, 3]),
    })
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function harness(): Promise<{ ctx: Context; bindingRoot: string }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  const bindingRoot = await mkdtemp(join(tmpdir(), 'dsh-codex-bindings-'))
  temporaryRoots.push(bindingRoot)
  return { ctx, bindingRoot }
}

async function installFactory(
  ctx: Context,
  bindingRoot: string,
  launcher: CodexConnectionLauncher,
  config: Config = {},
): Promise<CodexAgentFactory> {
  let factory: CodexAgentFactory | undefined
  await ctx.plugin(
    Object.assign(
      (pluginCtx: Context) => {
        factory = new CodexAgentFactory(pluginCtx, resolveConfig({ ...config, bindingRoot }), launcher)
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
      compactThread: () => Promise.resolve({ id: 'codex-compact-1', status: 'completed', items: [], error: null }),
      steer: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      close: () => {},
    },
  })
}

describe('Codex AgentFactory and Agent', () => {
  it('applies the live Codex model and reasoning selection to thread and turn requests', async () => {
    const { ctx, bindingRoot } = await harness()
    const base = mockLauncher()
    const sample = base(resolveConfig(), process.cwd(), vi.fn())
    const startThread = vi.fn(sample.client.startThread.bind(sample.client))
    const startTurn = vi.fn(sample.client.startTurn.bind(sample.client))
    const launcher: CodexConnectionLauncher = (config, cwd, handler) => {
      const connection = base(config, cwd, handler)
      connection.client.startThread = startThread
      connection.client.startTurn = startTurn
      return connection
    }
    const selection: ModelSelectionRef = {
      current: {
        provider: 'codex-app-server',
        model: 'gpt-5.6-sol',
        reasoningEffort: ReasoningEffortId('low'),
      },
      assembled: undefined,
    }
    const factory = await installFactory(ctx, bindingRoot, launcher)
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-model-selection'),
      setup: (agentCtx) => {
        agentCtx.effect(() => installModelSelection(agentCtx, selection))
      },
    })
    expect(startThread).toHaveBeenCalledWith(
      expect.any(String),
      { model: 'gpt-5.6-sol', reasoningEffort: 'low' },
      expect.any(Object),
    )
    expect(startThread.mock.calls[0]?.[2]?.developerInstructions).toContain('DeepSeek Harness')

    selection.current = {
      provider: 'codex-app-server',
      model: 'gpt-5.6-terra',
      reasoningEffort: ReasoningEffortId('ultra'),
    }
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    expect(startTurn).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'ultra',
    })
    await handle.dispose()
    await factory.dispose()
  })

  it('ignores the DSH default model unless the plugin explicitly configures one', async () => {
    const { ctx, bindingRoot } = await harness()
    const launchedModels: Array<string | undefined> = []
    const base = mockLauncher()
    const launcher: CodexConnectionLauncher = (config, cwd, handler) => {
      launchedModels.push(config.model)
      return base(config, cwd, handler)
    }
    const factory = await installFactory(ctx, bindingRoot, launcher)
    const handle = await ctx.agents.create({
      sessionId: SessionId('dsh-model-isolation'),
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash-202605' },
    })

    expect(launchedModels[0]).toBeUndefined()
    expect(handle.agent.options).toEqual({ provider: 'codex-app-server' })
    await handle.dispose()
    await factory.dispose()

    const configured = await harness()
    const configuredModels: Array<string | undefined> = []
    const configuredLauncher: CodexConnectionLauncher = (config, cwd, handler) => {
      configuredModels.push(config.model)
      return base(config, cwd, handler)
    }
    const configuredFactory = await installFactory(configured.ctx, configured.bindingRoot, configuredLauncher, {
      model: 'gpt-5.4',
    })
    const configuredHandle = await configured.ctx.agents.create({
      sessionId: SessionId('configured-codex-model'),
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash-202605' },
    })

    expect(configuredModels[0]).toBe('gpt-5.4')
    expect(configuredHandle.agent.options).toEqual({ provider: 'codex-app-server', model: 'gpt-5.4' })
    await configuredHandle.dispose()
    await configuredFactory.dispose()
  })

  it('refuses a foreign session selection instead of silently running it as Codex', async () => {
    const { ctx, bindingRoot } = await harness()
    const base = mockLauncher()
    const sample = base(resolveConfig(), process.cwd(), vi.fn())
    const startTurn = vi.fn(sample.client.startTurn.bind(sample.client))
    const launcher: CodexConnectionLauncher = (config, cwd, handler) => {
      const connection = base(config, cwd, handler)
      connection.client.startTurn = startTurn
      return connection
    }
    const selection: ModelSelectionRef = {
      current: { provider: 'tokenhub', model: 'legacy-model' },
      assembled: undefined,
    }
    const factory = await installFactory(ctx, bindingRoot, launcher)
    const handle = await ctx.agents.create({
      sessionId: SessionId('foreign-provider-selection'),
      setup: (agentCtx) => {
        agentCtx.effect(() => installModelSelection(agentCtx, selection))
      },
    })

    handle.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'use Codex' }], source: { kind: 'user' } }),
    )
    await handle.agent.whenIdle()

    expect(startTurn).not.toHaveBeenCalled()
    expect(handle.agent.session.events.findLast((event) => event.type === 'turn/end')?.data.reason).toEqual({
      kind: 'error',
      error: {
        code: 'CODEX_ERROR',
        message:
          'Codex-only profile cannot route provider "tokenhub"; select a "codex-app-server" model for this session',
      },
    })
    await handle.dispose()
    await factory.dispose()
  })

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

  it('rejects a concurrent duplicate identity before launching a second process', async () => {
    const { ctx, bindingRoot } = await harness()
    const launch = vi.fn(mockLauncher())
    const factory = await installFactory(ctx, bindingRoot, launch)
    const setup = Promise.withResolvers<void>()
    const first = ctx.agents.create({
      sessionId: SessionId('duplicate'),
      setup: () => setup.promise,
    })
    await expect(ctx.agents.create({ sessionId: SessionId('duplicate') })).rejects.toThrow(/already being created/)
    setup.resolve()
    const handle = await first
    expect(launch).toHaveBeenCalledOnce()
    await handle.dispose()
    await factory.dispose()
  })

  it('aborts an unpublished setup without launching or publishing', async () => {
    const { ctx, bindingRoot } = await harness()
    const launch = vi.fn(mockLauncher())
    const factory = await installFactory(ctx, bindingRoot, launch)
    const controller = new AbortController()
    const creating = ctx.agents.create({
      sessionId: SessionId('aborted-setup'),
      signal: controller.signal,
      setup: () => new Promise<void>(() => {}),
    })
    controller.abort(new Error('caller stopped'))
    await expect(creating).rejects.toThrow('caller stopped')
    expect(launch).not.toHaveBeenCalled()
    expect(ctx.sessions.get(SessionId('aborted-setup'))).toBeUndefined()
    await factory.dispose()
  })

  it('resumes only the exact durable Codex thread and workspace', async () => {
    const { ctx, bindingRoot } = await harness()
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-codex-resume-'))
    temporaryRoots.push(workspace)
    const resumeThread = vi.fn<CodexConnection['client']['resumeThread']>((threadId: string) =>
      Promise.resolve({
        thread: { id: threadId, ephemeral: false, cwd: workspace, cliVersion: '0.147.0' },
        model: 'gpt-5',
        modelProvider: 'openai',
        cwd: workspace,
      }),
    )
    const base = mockLauncher()
    const launcher: CodexConnectionLauncher = (config, cwd, handler) => {
      const connection = base(config, cwd, handler)
      connection.client.resumeThread = resumeThread
      return connection
    }
    const factory = await installFactory(ctx, bindingRoot, launcher)
    const id = SessionId('resumable')
    const first = await ctx.agents.create({ sessionId: id, meta: { cwd: workspace } })
    const snapshot: { meta: SessionHeader; events: SessionEvent[] } = {
      meta: structuredClone(first.agent.session.header),
      events: structuredClone(first.agent.session.events) as SessionEvent[],
    }
    await first.dispose()
    ctx.provide('sessionPersistence', {
      prepare: () =>
        Promise.resolve(
          SessionPreparation.create(
            ctx.sessions.prepare(id, { seed: snapshot.events, meta: snapshot.meta, seedSource: 'persistence' }),
          ),
        ),
    } as never)
    const resumed = await ctx.agents.resume({ resumeSessionId: id })
    expect(resumeThread).toHaveBeenCalledWith('codex-thread-1', workspace, undefined, expect.any(Object))
    expect(resumeThread.mock.calls[0]?.[3]?.developerInstructions).toContain('DeepSeek Harness')
    await resumed.dispose()
    await factory.dispose()
  })

  it('replaces an unmaterialized Codex thread only for a blank persisted session', async () => {
    const { ctx, bindingRoot } = await harness()
    const startThread = vi.fn((cwd: string) => {
      const threadNumber = startThread.mock.calls.length
      return Promise.resolve({
        thread: { id: `codex-thread-${threadNumber}`, ephemeral: false, cwd, cliVersion: '0.147.0' },
        model: 'gpt-5',
        modelProvider: 'openai',
        cwd,
      })
    })
    const resumeThread = vi.fn<CodexConnection['client']['resumeThread']>((threadId: string) =>
      Promise.reject(
        new CodexAppServerError(
          'PROTOCOL_INVALID',
          `App Server error -32600: no rollout found for thread id ${threadId}`,
        ),
      ),
    )
    const base = mockLauncher()
    const launcher: CodexConnectionLauncher = (config, cwd, handler) => {
      const connection = base(config, cwd, handler)
      connection.client.startThread = startThread
      connection.client.resumeThread = resumeThread
      return connection
    }
    const factory = await installFactory(ctx, bindingRoot, launcher)
    const id = SessionId('blank-unmaterialized-thread')
    const first = await ctx.agents.create({ sessionId: id })
    const snapshot: { meta: SessionHeader; events: SessionEvent[] } = {
      meta: structuredClone(first.agent.session.header),
      events: structuredClone(first.agent.session.events) as SessionEvent[],
    }
    await first.dispose()
    ctx.provide('sessionPersistence', {
      prepare: () =>
        Promise.resolve(
          SessionPreparation.create(
            ctx.sessions.prepare(id, { seed: snapshot.events, meta: snapshot.meta, seedSource: 'persistence' }),
          ),
        ),
    } as never)

    const resumed = await ctx.agents.resume({ resumeSessionId: id })

    expect(resumeThread).toHaveBeenCalledWith('codex-thread-1', expect.any(String), undefined, expect.any(Object))
    expect(resumeThread.mock.calls[0]?.[3]?.developerInstructions).toContain('DeepSeek Harness')
    expect(startThread).toHaveBeenCalledTimes(2)
    await expect(new ThreadBindingStore(bindingRoot).read(id, process.cwd())).resolves.toMatchObject({
      threadId: 'codex-thread-2',
    })
    await resumed.dispose()
    await factory.dispose()
  })

  it('replaces an unmaterialized thread after a request fails before the first model step', async () => {
    const { ctx, bindingRoot } = await harness()
    let starts = 0
    const base = mockLauncher()
    const launcher: CodexConnectionLauncher = (config, cwd, handler) => {
      const connection = base(config, cwd, handler)
      connection.client.startThread = () => {
        starts += 1
        return Promise.resolve({
          thread: { id: `codex-thread-${starts}`, ephemeral: false, cwd, cliVersion: '0.147.0' },
          model: 'gpt-5',
          modelProvider: 'openai',
          cwd,
        })
      }
      connection.client.resumeThread = (threadId) =>
        Promise.reject(
          new CodexAppServerError(
            'PROTOCOL_INVALID',
            `App Server error -32600: no rollout found for thread id ${threadId}`,
          ),
        )
      return connection
    }
    const factory = await installFactory(ctx, bindingRoot, launcher)
    const id = SessionId('failed-before-first-step')
    const first = await ctx.agents.create({
      sessionId: id,
      setup: (agentCtx) => {
        agentCtx.on('agent/request', async (payload, next) => {
          if (payload.turn > 0) throw new Error('selection failed before model request')
          return next()
        })
      },
    })
    first.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'never reached Codex' }], source: { kind: 'user' } }),
    )
    await first.agent.whenIdle()
    expect(first.agent.session.events.some((event) => event.type === 'step/start')).toBe(false)
    const snapshot: { meta: SessionHeader; events: SessionEvent[] } = {
      meta: structuredClone(first.agent.session.header),
      events: structuredClone(first.agent.session.events) as SessionEvent[],
    }
    await first.dispose()
    ctx.provide('sessionPersistence', {
      prepare: () =>
        Promise.resolve(
          SessionPreparation.create(
            ctx.sessions.prepare(id, { seed: snapshot.events, meta: snapshot.meta, seedSource: 'persistence' }),
          ),
        ),
    } as never)

    const resumed = await ctx.agents.resume({ resumeSessionId: id })

    expect(starts).toBe(2)
    await expect(new ThreadBindingStore(bindingRoot).read(id, process.cwd())).resolves.toMatchObject({
      threadId: 'codex-thread-2',
    })
    await resumed.dispose()
    await factory.dispose()
  })

  it('does not replace a missing Codex rollout when persisted session content exists', async () => {
    const { ctx, bindingRoot } = await harness()
    let starts = 0
    const base = mockLauncher()
    const launcher: CodexConnectionLauncher = (config, cwd, handler) => {
      const connection = base(config, cwd, handler)
      connection.client.startThread = () => {
        starts += 1
        return Promise.resolve({
          thread: { id: 'codex-thread-1', ephemeral: false, cwd, cliVersion: '0.147.0' },
          model: 'gpt-5',
          modelProvider: 'openai',
          cwd,
        })
      }
      connection.client.resumeThread = (threadId) =>
        Promise.reject(
          new CodexAppServerError(
            'PROTOCOL_INVALID',
            `App Server error -32600: no rollout found for thread id ${threadId}`,
          ),
        )
      return connection
    }
    const factory = await installFactory(ctx, bindingRoot, launcher)
    const id = SessionId('nonblank-missing-thread')
    const first = await ctx.agents.create({ sessionId: id })
    first.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'persist me' }], source: { kind: 'user' } }),
    )
    await first.agent.whenIdle()
    const snapshot: { meta: SessionHeader; events: SessionEvent[] } = {
      meta: structuredClone(first.agent.session.header),
      events: structuredClone(first.agent.session.events) as SessionEvent[],
    }
    await first.dispose()
    ctx.provide('sessionPersistence', {
      prepare: () =>
        Promise.resolve(
          SessionPreparation.create(
            ctx.sessions.prepare(id, { seed: snapshot.events, meta: snapshot.meta, seedSource: 'persistence' }),
          ),
        ),
    } as never)

    await expect(ctx.agents.resume({ resumeSessionId: id })).rejects.toThrow('no rollout found')
    expect(starts).toBe(1)
    await factory.dispose()
  })

  it('sends injected context in the next turn without waking on inject alone', async () => {
    const { ctx, bindingRoot } = await harness()
    const prompts: string[] = []
    const base = mockLauncher()
    const launcher: CodexConnectionLauncher = (config, cwd, handler) => {
      const connection = base(config, cwd, handler)
      const run = connection.client.startTurn.bind(connection.client)
      connection.client.startTurn = (input, callbacks) => {
        prompts.push(renderedText(input))
        return run(input, callbacks)
      }
      return connection
    }
    const factory = await installFactory(ctx, bindingRoot, launcher)
    const handle = await ctx.agents.create({ sessionId: SessionId('injected-context') })
    handle.agent.inject(
      createUserMessage({ content: [{ type: 'text', text: 'quiet context' }], source: { kind: 'user' } }),
    )
    await handle.agent.whenIdle()
    expect(prompts).toEqual([])
    handle.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'wake now' }], source: { kind: 'user' } }),
    )
    await handle.agent.whenIdle()
    expect(prompts).toEqual(['quiet context\n\nwake now'])
    await handle.dispose()
    await factory.dispose()
  })

  it('loads durable image attachments into native Codex image inputs', async () => {
    const { ctx, bindingRoot } = await harness()
    await ctx.plugin(TestAttachments)
    const captured: TurnInput[][] = []
    const base = mockLauncher()
    const launcher: CodexConnectionLauncher = (config, cwd, handler) => {
      const connection = base(config, cwd, handler)
      const run = connection.client.startTurn.bind(connection.client)
      connection.client.startTurn = (input, callbacks) => {
        captured.push([...input])
        return run(input, callbacks)
      }
      return connection
    }
    const factory = await installFactory(ctx, bindingRoot, launcher)
    const handle = await ctx.agents.create({ sessionId: SessionId('image-input') })
    handle.agent.followup(
      createUserMessage({
        content: [
          { type: 'text', text: 'inspect' },
          {
            type: 'image',
            attachment: {
              attachmentId: AttachmentId('image-1'),
              mediaType: 'image/png',
              bytes: 3,
              width: 1,
              height: 1,
            },
          },
        ],
        source: { kind: 'user' },
      }),
    )
    await handle.agent.whenIdle()
    expect(captured[0]).toEqual([
      { type: 'text', text: 'inspect', text_elements: [] },
      { type: 'text', text: '\n', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,AQID' },
    ])
    await handle.dispose()
    await factory.dispose()
  })

  it('relaunches and exactly resumes the thread after a turn watchdog failure', async () => {
    const { ctx, bindingRoot } = await harness()
    let launches = 0
    const resumed = vi.fn()
    const base = mockLauncher()
    const launcher: CodexConnectionLauncher = (config, cwd, handler) => {
      launches += 1
      const connection = base(config, cwd, handler)
      if (launches === 1) {
        connection.client.startTurn = () =>
          Promise.reject(new CodexAppServerError('TURN_IDLE_TIMEOUT', 'simulated stuck turn'))
      } else {
        const resume = connection.client.resumeThread.bind(connection.client)
        connection.client.resumeThread = (threadId, resumeCwd) => {
          resumed(threadId, resumeCwd)
          return resume(threadId, resumeCwd)
        }
      }
      return connection
    }
    const factory = await installFactory(ctx, bindingRoot, launcher)
    const handle = await ctx.agents.create({ sessionId: SessionId('watchdog-recovery') })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    expect(launches).toBe(2)
    expect(resumed).toHaveBeenCalledWith('codex-thread-1', expect.any(String))
    await handle.dispose()
    await factory.dispose()
  })

  it('starts a fork on a new thread and injects bounded seed history only once', async () => {
    const { ctx, bindingRoot } = await harness()
    const prompts: string[] = []
    let threadNumber = 0
    const base = mockLauncher()
    const launcher: CodexConnectionLauncher = (config, cwd, handler) => {
      const connection = base(config, cwd, handler)
      connection.client.startThread = () => {
        threadNumber += 1
        return Promise.resolve({
          thread: { id: `thread-${threadNumber}`, ephemeral: false, cwd, cliVersion: '0.147.0' },
          model: 'gpt-5',
          modelProvider: 'openai',
          cwd,
        })
      }
      const run = connection.client.startTurn.bind(connection.client)
      connection.client.startTurn = (input, callbacks) => {
        prompts.push(renderedText(input))
        return run(input, callbacks)
      }
      return connection
    }
    const factory = await installFactory(ctx, bindingRoot, launcher)
    const parentId = SessionId('fork-parent')
    const parent = await ctx.agents.create({ sessionId: parentId })
    parent.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'parent question' }], source: { kind: 'user' } }),
    )
    await parent.agent.whenIdle()
    const seed = structuredClone(parent.agent.session.events) as SessionEvent[]
    await parent.dispose()

    prompts.length = 0
    const fork = await ctx.agents.create({
      sessionId: SessionId('fork-child'),
      seed,
      meta: { parentSession: parentId, seedLength: seed.length },
    })
    fork.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'child first' }], source: { kind: 'user' } }),
    )
    await fork.agent.whenIdle()
    fork.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'child second' }], source: { kind: 'user' } }),
    )
    await fork.agent.whenIdle()
    expect(threadNumber).toBe(2)
    expect(prompts[0]).toContain('Inherited DSH session context')
    expect(prompts[0]).toContain('parent question')
    expect(prompts[0]).toContain('child first')
    expect(prompts[1]).toBe('child second')
    await fork.dispose()
    await factory.dispose()
  })
})
