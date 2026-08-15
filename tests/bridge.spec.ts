import { Context } from '@deepseek-ai/cordis'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assembleCodexBridge, executeDshDynamicTool } from '../src/bridge.js'

function stubAgent(ctx: Context, cwd?: string): Agent {
  const id = SessionId('bridge-agent')
  const session = Session.create(id, undefined, {
    version: 0,
    id,
    createdAt: 0,
    ...(cwd === undefined ? {} : { cwd }),
  })
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx,
    cancel: () => {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: (task) => task(new AbortController().signal),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
  }
}

describe('DSH execution bridge', () => {
  it('injects scoped instructions and returns real DSH tool execution to Codex', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: 'Operate as the deployment persona in {{cwd}}.' })
    await ctx.plugin(ToolRuntime, {})
    ctx.systemPrompt.variable('cwd', (context) => context.agent?.session.header.cwd)
    const execute = vi.fn((args: { text: string }, exec: { callId: string }) =>
      Promise.resolve({ echoed: args.text, callId: exec.callId }),
    )
    ctx.tools.register(
      defineTool({
        name: 'echo',
        description: 'Echo one text value.',
        parameters: { text: { type: 'string', required: true } },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              echoed: { type: 'string', required: true },
              callId: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute,
      }),
    )
    const cwd = resolve('worktree')
    const agent = stubAgent(ctx, cwd)
    const signal = new AbortController().signal
    const bridge = await assembleCodexBridge(ctx, agent, signal)

    expect(bridge.developerInstructions).toContain(`Operate as the deployment persona in ${cwd}.`)
    expect(bridge.developerInstructions).toContain('without overriding OpenAI system instructions')
    expect(bridge.dynamicTools).toHaveLength(1)
    expect(bridge.dynamicTools[0]?.name).toBe('dsh')
    expect(bridge.dynamicTools[0]?.tools[0]?.name).toBe('echo')
    expect(bridge.dynamicTools[0]?.tools[0]?.inputSchema).toMatchObject({ type: 'object' })

    await expect(
      executeDshDynamicTool(
        ctx,
        agent,
        {
          id: 7,
          method: 'item/tool/call',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            callId: 'call-17',
            namespace: 'dsh',
            tool: 'echo',
            arguments: { text: 'hello' },
          },
        },
        signal,
      ),
    ).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: '{"echoed":"hello","callId":"call-17"}' }],
      success: true,
    })
    expect(execute).toHaveBeenCalledOnce()
  })
})
