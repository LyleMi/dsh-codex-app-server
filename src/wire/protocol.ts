import { CodexAppServerError } from '../errors.js'

export type JsonRpcId = number | string

export interface JsonRpcRequest {
  jsonrpc?: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc?: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc?: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/** Codex thread item fields used by the first projection version. */
export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string; phase: string | null }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution'
      id: string
      command: string
      cwd: string
      status: string
      aggregatedOutput: string | null
      exitCode: number | null
      durationMs: number | null
    }
  | { type: 'fileChange'; id: string; changes: unknown[]; status: string }
  | { type: string; id?: string; [key: string]: unknown }

export interface TurnValue {
  id: string
  status: string
  items: ThreadItem[]
  error: { message: string; codexErrorInfo?: string | null } | null
}

export interface ThreadValue {
  id: string
  ephemeral: boolean
  cwd: string
  cliVersion: string
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodexAppServerError('PROTOCOL_INVALID', `${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringField(value: Record<string, unknown>, key: string, context: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) {
    throw new CodexAppServerError('PROTOCOL_INVALID', `${context}.${key} must be a non-empty string`)
  }
  return field
}

function decodeJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown
  } catch (error: unknown) {
    throw new CodexAppServerError('PROTOCOL_INVALID', 'App Server emitted invalid JSON', { cause: error })
  }
}

function validateEnvelope(value: Record<string, unknown>): JsonRpcId | undefined {
  if (value['jsonrpc'] !== undefined && value['jsonrpc'] !== '2.0') {
    throw new CodexAppServerError('PROTOCOL_INVALID', 'App Server frame has an unsupported jsonrpc version')
  }
  const id = value['id']
  if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') {
    throw new CodexAppServerError('PROTOCOL_INVALID', 'JSON-RPC id must be a string or number')
  }
  return id
}

/** Parse and minimally validate a JSON-RPC 2.0 frame without rejecting extensions. */
export function parseJsonRpc(line: string): JsonRpcMessage {
  const value = record(decodeJson(line), 'JSON-RPC frame')
  const id = validateEnvelope(value)
  if (value['method'] !== undefined) {
    stringField(value, 'method', 'JSON-RPC frame')
    return value as unknown as JsonRpcRequest | JsonRpcNotification
  }
  if (id === undefined || (!('result' in value) && !('error' in value))) {
    throw new CodexAppServerError('PROTOCOL_INVALID', 'invalid JSON-RPC response')
  }
  return value as unknown as JsonRpcResponse
}

/** Validate the initialize result fields needed for capability diagnostics. */
export function parseInitializeResult(value: unknown): {
  userAgent: string
  platformFamily: string
  platformOs: string
} {
  const result = record(value, 'initialize result')
  return {
    userAgent: stringField(result, 'userAgent', 'initialize result'),
    platformFamily: stringField(result, 'platformFamily', 'initialize result'),
    platformOs: stringField(result, 'platformOs', 'initialize result'),
  }
}

/** Validate a thread start/resume result and retain durable binding facts. */
export function parseThreadResult(value: unknown): {
  thread: ThreadValue
  model: string
  modelProvider: string
  cwd: string
} {
  const result = record(value, 'thread result')
  const thread = record(result['thread'], 'thread result.thread')
  const id = stringField(thread, 'id', 'thread result.thread')
  const cwd = stringField(result, 'cwd', 'thread result')
  return {
    thread: {
      id,
      ephemeral: thread['ephemeral'] === true,
      cwd,
      cliVersion: typeof thread['cliVersion'] === 'string' ? thread['cliVersion'] : 'unknown',
    },
    model: stringField(result, 'model', 'thread result'),
    modelProvider: stringField(result, 'modelProvider', 'thread result'),
    cwd,
  }
}

/** Validate the turn start result. */
export function parseTurnStartResult(value: unknown): TurnValue {
  const result = record(value, 'turn/start result')
  return parseTurn(result['turn'], 'turn/start result.turn')
}

/** Validate the stable turn fields while allowing new item variants. */
export function parseTurn(value: unknown, context = 'turn'): TurnValue {
  const turn = record(value, context)
  const items = turn['items']
  if (!Array.isArray(items)) throw new CodexAppServerError('PROTOCOL_INVALID', `${context}.items must be an array`)
  return {
    id: stringField(turn, 'id', context),
    status: stringField(turn, 'status', context),
    items: items.map((item, index) => record(item, `${context}.items[${index}]`) as ThreadItem),
    error:
      turn['error'] === null || turn['error'] === undefined
        ? null
        : (record(turn['error'], `${context}.error`) as TurnValue['error']),
  }
}

/** Read the routing ids common to turn-scoped notifications and requests. */
export function parseTurnRoute(params: unknown): {
  threadId: string
  turnId: string
} {
  const value = record(params, 'turn-scoped params')
  return {
    threadId: stringField(value, 'threadId', 'turn-scoped params'),
    turnId: stringField(value, 'turnId', 'turn-scoped params'),
  }
}

/** Validate item lifecycle notification fields. */
export function parseItemNotification(params: unknown): {
  threadId: string
  turnId: string
  item: ThreadItem
} {
  const route = parseTurnRoute(params)
  const value = params as Record<string, unknown>
  return {
    ...route,
    item: record(value['item'], 'item notification.item') as ThreadItem,
  }
}
