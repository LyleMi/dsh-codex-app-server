import { createHash } from 'node:crypto'
import type AttachmentStore from '@deepseek-ai/dsh-attachment'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextSnapshotSection, ToolSchema } from '@deepseek-ai/dsh-llm'
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { CodexAppServerError } from './errors.js'
import type { JsonRpcRequest } from './wire/protocol.js'

const DSH_NAMESPACE = 'dsh'
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/u

const OWNERSHIP_INSTRUCTIONS = `Integration ownership:
- Instructions above this section are assembled by DeepSeek Harness (DSH) for this agent scope. Follow them as developer instructions without overriding OpenAI system instructions, safety controls, or the user's request.
- Tools in the dsh namespace are discovered, authorized, executed, cancelled, and audited by the DSH tool runtime. Their callId is the Codex callId unchanged.
- Codex built-in tools, MCP/apps, native collaboration/delegation, Codex skills, and Codex thread compaction remain owned by Codex and its App Server approval model.
- DSH skills, subagents/workflows, and Cordis dynamic packages are DSH-owned capabilities reached only through dsh tools and DSH-provided instructions. Do not treat a Codex capability and a dsh capability with a similar name as the same execution path.`

export interface DynamicToolFunction {
  type: 'function'
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface DynamicToolNamespace {
  type: 'namespace'
  name: string
  description: string
  tools: DynamicToolFunction[]
}

export interface CodexBridgeSnapshot {
  developerInstructions: string
  dynamicTools: DynamicToolNamespace[]
  contextText: string
  contextSections: ContextSnapshotSection[]
  fingerprint: string
}

export interface DynamicToolResponse {
  contentItems: Array<{ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }>
  success: boolean
}

/** Assemble one agent-scoped DSH instruction and tool snapshot for a Codex thread. */
export async function assembleCodexBridge(
  ctx: Context,
  agent: Agent,
  signal: AbortSignal,
): Promise<CodexBridgeSnapshot> {
  const systemPrompt = ctx.get('systemPrompt')
  const tools = ctx.get('tools')
  if (systemPrompt === undefined || tools === undefined) {
    throw new Error('Codex execution bridge requires the DSH systemPrompt and tools services')
  }
  const assembly = await systemPrompt.assemble(assembleContextFor(agent, signal))
  signal.throwIfAborted()
  const schemas = assembly.tools.map(validateToolSchema)
  const dynamicTools: DynamicToolNamespace[] =
    schemas.length === 0
      ? []
      : [
          {
            type: 'namespace',
            name: DSH_NAMESPACE,
            description: 'DeepSeek Harness tools executed by the scoped DSH runtime and its policy pipeline.',
            tools: schemas.map(toDynamicTool),
          },
        ]
  const prompt = renderPrompt(assembly)
  const contextSections = renderContextSections(assembly)
  const contextText = joinContextSections(contextSections)
  const developerInstructions = prompt === '' ? OWNERSHIP_INSTRUCTIONS : `${prompt}\n\n${OWNERSHIP_INSTRUCTIONS}`
  const fingerprint = createHash('sha256').update(JSON.stringify({ developerInstructions, dynamicTools })).digest('hex')
  return { developerInstructions, dynamicTools, contextText, contextSections, fingerprint }
}

/** Execute one App Server dynamic call through the DSH tool policy and implementation pipeline. */
export async function executeDshDynamicTool(
  ctx: Context,
  agent: Agent,
  request: JsonRpcRequest,
  signal: AbortSignal,
): Promise<DynamicToolResponse> {
  const params = record(request.params, 'item/tool/call params')
  const namespace = params['namespace']
  const name = stringField(params, 'tool')
  const callId = stringField(params, 'callId')
  if (namespace !== DSH_NAMESPACE) {
    throw new CodexAppServerError('PROTOCOL_INVALID', `dynamic tool namespace must be ${JSON.stringify(DSH_NAMESPACE)}`)
  }
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('DSH tool runtime is unavailable')
  const result = await tools.execute({
    callId: CallId(callId),
    name,
    arguments: params['arguments'],
    agent,
    signal,
  })
  signal.throwIfAborted()
  return {
    contentItems: await renderExecutionResult(ctx, result, signal),
    success: !result.isError,
  }
}

function validateToolSchema(schema: ToolSchema): ToolSchema {
  if (!TOOL_NAME.test(schema.name)) {
    throw new Error(`DSH tool name ${JSON.stringify(schema.name)} is not valid for Codex dynamicTools`)
  }
  return schema
}

function toDynamicTool(schema: ToolSchema): DynamicToolFunction {
  return {
    type: 'function',
    name: schema.name,
    description: schema.description,
    inputSchema: schema.parameters,
  }
}

async function renderExecutionResult(
  ctx: Context,
  result: ToolExecutionResult,
  signal: AbortSignal,
): Promise<DynamicToolResponse['contentItems']> {
  const content = [...result.content]
  for (const message of result.additionalContexts ?? []) content.push(...message.content)
  if (result.concludesTurn === true) {
    content.push({ type: 'text', text: 'DSH marked this successful tool result as terminal for the current task.' })
  }
  const items: DynamicToolResponse['contentItems'] = []
  for (const block of content) items.push(await renderContent(ctx, block, signal))
  if (items.length === 0) items.push({ type: 'inputText', text: result.isError ? result.error.message : '' })
  return items
}

async function renderContent(
  ctx: Context,
  block: ContentBlock,
  signal: AbortSignal,
): Promise<DynamicToolResponse['contentItems'][number]> {
  if (block.type === 'text' || block.type === 'reasoning') return { type: 'inputText', text: block.text }
  if (block.type === 'image') {
    const attachments: AttachmentStore | undefined = ctx.get('attachments')
    if (attachments === undefined) throw new Error('cannot return a DSH image tool result without an attachment store')
    const stored = await attachments.readImage(block.attachment, signal)
    return {
      type: 'inputImage',
      imageUrl: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`,
    }
  }
  throw new Error(`Codex dynamic tool responses do not support DSH ${block.type} content blocks`)
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodexAppServerError('PROTOCOL_INVALID', `${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) {
    throw new CodexAppServerError('PROTOCOL_INVALID', `item/tool/call params.${key} must be a non-empty string`)
  }
  return field
}
