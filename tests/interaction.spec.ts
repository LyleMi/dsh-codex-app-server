import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it, vi } from 'vitest'
import { handleCodexInteraction } from '../src/interaction.js'

function stubAgent(id = 'interaction-agent'): Agent {
  const session = Session.create(SessionId(id))
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    cancel: () => {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: (task) => task(new AbortController().signal),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
  }
}

describe('Codex interaction mapping', () => {
  it('uses DSH approval and records its durable audit pair', async () => {
    const ctx = new Context()
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    ctx.on('approval/request', () => Promise.resolve('allowed-once'))
    const agent = stubAgent()
    agent.session.append('turn/start', { turn: 1 })
    await expect(
      handleCodexInteraction(
        ctx,
        agent,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'item/commandExecution/requestApproval',
          params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', reason: 'needs shell' },
        },
        undefined,
      ),
    ).resolves.toEqual({ decision: 'accept' })
    expect(agent.session.events.map((event) => event.type)).toEqual([
      'turn/start',
      'approval/asked',
      'approval/decided',
    ])
  })

  it('fails closed when no approval or question provider exists', async () => {
    const ctx = new Context()
    const agent = stubAgent()
    await expect(
      handleCodexInteraction(
        ctx,
        {
          ...agent,
          status: 'running',
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'item/fileChange/requestApproval',
          params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
        },
        undefined,
      ),
    ).resolves.toEqual({ decision: 'decline' })
  })

  it('maps DSH structured answers back to Codex question ids', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    ctx.userQuestions.registerProvider({
      ask: (request) => Promise.resolve({ answers: [{ id: request.questions[0]?.id ?? '', selected: ['Yes'] }] }),
    })
    const agent = stubAgent('question-agent')
    ctx.agents.register(agent)
    await expect(
      handleCodexInteraction(
        ctx,
        agent,
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'item/tool/requestUserInput',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-1',
            questions: [{ id: 'choice', header: 'Choose', question: 'Continue?', options: [{ label: 'Yes' }] }],
          },
        },
        undefined,
      ),
    ).resolves.toEqual({ answers: { choice: { answers: ['Yes'] } } })
  })

  it('declines nonblocking and secret questions without invoking a provider', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const ask = vi.fn(() => Promise.resolve({ answers: [] }))
    ctx.userQuestions.registerProvider({ ask })
    const agent = stubAgent('safe-question-agent')
    ctx.agents.register(agent)
    const base = {
      jsonrpc: '2.0' as const,
      id: 4,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [{ id: 'password', question: 'Password?', isSecret: true }],
      },
    }
    await expect(handleCodexInteraction(ctx, agent, base, undefined)).resolves.toEqual({ answers: {} })
    await expect(
      handleCodexInteraction(ctx, agent, { ...base, params: { ...base.params, isBlocking: false } }, undefined),
    ).resolves.toEqual({ answers: {} })
    expect(ask).not.toHaveBeenCalled()
  })

  it('drops custom text when Codex disallows the other option', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    ctx.userQuestions.registerProvider({
      ask: () => Promise.resolve({ answers: [{ id: 'choice', selected: ['Yes'], custom: 'injected' }] }),
    })
    const agent = stubAgent('no-other-agent')
    ctx.agents.register(agent)
    await expect(
      handleCodexInteraction(
        ctx,
        agent,
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'item/tool/requestUserInput',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-1',
            questions: [{ id: 'choice', question: 'Continue?', isOther: false }],
          },
        },
        undefined,
      ),
    ).resolves.toEqual({ answers: { choice: { answers: ['Yes'] } } })
  })
})
