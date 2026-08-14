import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionItem, UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonRpcRequest } from './wire/protocol.js'

/** Map supported Codex server requests to optional DSH human-interaction services. */
export async function handleCodexInteraction(
  ctx: Context,
  agent: Agent,
  request: JsonRpcRequest,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
      return approvalDecision(ctx, agent, request.params, signal, 'codex-command')
    case 'item/fileChange/requestApproval':
      return approvalDecision(ctx, agent, request.params, signal, 'codex-file-change')
    case 'item/permissions/requestApproval':
      return permissionDecision(ctx, agent, request.params, signal)
    case 'item/tool/requestUserInput':
      return userInputDecision(ctx, agent, request.params, signal)
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null }
    default:
      throw new Error(`unsupported Codex interaction ${request.method}`)
  }
}

async function approvalDecision(
  ctx: Context,
  agent: Agent,
  params: unknown,
  signal: AbortSignal | undefined,
  toolName: string,
): Promise<{ decision: 'accept' | 'decline' | 'cancel' }> {
  const outcome = await requestApproval(ctx, agent, params, signal, toolName)
  return { decision: outcome === 'allowed-once' ? 'accept' : outcome === 'cancelled' ? 'cancel' : 'decline' }
}

async function permissionDecision(
  ctx: Context,
  agent: Agent,
  params: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const outcome = await requestApproval(ctx, agent, params, signal, 'codex-permissions')
  if (outcome !== 'allowed-once') throw new Error(`Codex permission request ${outcome}`)
  const value = asRecord(params)
  const requested = asRecord(value['permissions'])
  const permissions = {
    ...(requested['network'] === null || requested['network'] === undefined ? {} : { network: requested['network'] }),
    ...(requested['fileSystem'] === null || requested['fileSystem'] === undefined
      ? {}
      : { fileSystem: requested['fileSystem'] }),
  }
  return { permissions, scope: 'turn' }
}

async function requestApproval(
  ctx: Context,
  agent: Agent,
  params: unknown,
  signal: AbortSignal | undefined,
  toolName: string,
): Promise<ApprovalOutcome> {
  const approval: ApprovalService | undefined = ctx.get('approval')
  if (approval === undefined) return 'unavailable'
  const value = asRecord(params)
  const reason = typeof value['reason'] === 'string' ? value['reason'] : undefined
  return approval.request({
    agent,
    toolName,
    ...(reason === undefined ? {} : { reason }),
    ...(signal === undefined ? {} : { signal }),
  })
}

async function userInputDecision(
  ctx: Context,
  agent: Agent,
  params: unknown,
  signal: AbortSignal | undefined,
): Promise<{ answers: Record<string, { answers: string[] }> }> {
  const service: UserQuestionService | undefined = ctx.get('userQuestions')
  if (service === undefined) return { answers: {} }
  const value = asRecord(params)
  if (!Array.isArray(value['questions'])) return { answers: {} }
  const questions = value['questions'].map(parseQuestion)
  try {
    const answer = await service.ask({ questions, agent, ...(signal === undefined ? {} : { signal }) })
    return {
      answers: Object.fromEntries(
        answer.answers.map((item) => [
          item.id,
          { answers: [...item.selected, ...(item.custom === undefined ? [] : [item.custom])] },
        ]),
      ),
    }
  } catch {
    return { answers: {} }
  }
}

function parseQuestion(value: unknown): AskUserQuestionItem {
  const question = asRecord(value)
  if (typeof question['id'] !== 'string' || typeof question['question'] !== 'string') {
    throw new Error('invalid Codex user-input question')
  }
  const options = Array.isArray(question['options'])
    ? question['options'].flatMap((option) => {
        const item = asRecord(option)
        return typeof item['label'] === 'string'
          ? [
              {
                label: item['label'],
                ...(typeof item['description'] === 'string' ? { description: item['description'] } : {}),
              },
            ]
          : []
      })
    : undefined
  return {
    id: question['id'],
    question: question['question'],
    ...(typeof question['header'] === 'string' ? { header: question['header'] } : {}),
    ...(options === undefined ? {} : { options }),
    multiSelect: false,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}
