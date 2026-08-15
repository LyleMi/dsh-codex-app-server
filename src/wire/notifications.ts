import type { ResolvedConfig } from '../config.js'
import { CodexAppServerError, redactDiagnostic } from '../errors.js'
import type { ThreadItem, TurnValue } from './protocol.js'
import { parseItemNotification, parseTurn, parseTurnRoute } from './protocol.js'

export interface TurnCallbacks {
  itemStarted?(item: ThreadItem): void
  itemCompleted?(item: ThreadItem): void
  agentMessageDelta?(itemId: string, delta: string): void
  reasoningDelta?(itemId: string, delta: string, kind: 'summary' | 'content'): void
  commandOutputDelta?(itemId: string, delta: string): void
  usage?(value: unknown): void
  unknownNotification?(method: string, params: unknown): void
}

export interface ProtocolDiagnostic {
  level: 'error' | 'warn' | 'info'
  method: string
  message: string
}

export interface ActiveTurn {
  threadId: string
  turnId?: string
  callbacks: TurnCallbacks
  completion: PromiseWithResolvers<TurnValue>
  turnReady: PromiseWithResolvers<void>
  activity(): void
}

function matches(active: ActiveTurn, threadId: string, turnId: string): boolean {
  if (threadId !== active.threadId) return false
  if (active.turnId === undefined) {
    active.turnId = turnId
    active.turnReady.resolve()
  }
  const matched = active.turnId === turnId
  if (matched) active.activity()
  return matched
}

/** Return the active turn only when generic turn-scoped parameters correlate. */
export function requireActiveRoute(active: ActiveTurn | undefined, params: unknown): ActiveTurn | undefined {
  if (active === undefined) return undefined
  const route = parseTurnRoute(params)
  return matches(active, route.threadId, route.turnId) ? active : undefined
}

function routeTurnLifecycle(active: ActiveTurn, method: string, params: unknown): boolean {
  if (method !== 'turn/started' && method !== 'turn/completed') return false
  const value = params as Record<string, unknown>
  if (value['threadId'] !== active.threadId) return true
  const turn = parseTurn(value['turn'], `${method}.turn`)
  if (active.turnId !== undefined && active.turnId !== turn.id) return true
  active.turnId = turn.id
  active.turnReady.resolve()
  active.activity()
  if (method === 'turn/completed') active.completion.resolve(turn)
  return true
}

function diagnosticMessage(params: unknown, ...keys: string[]): string | undefined {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined
  const value = params as Record<string, unknown>
  for (const key of keys) {
    if (typeof value[key] === 'string') return value[key]
  }
  const error = value['error']
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>)['message']
    if (typeof message === 'string') return message
  }
  return undefined
}

type DiagnosticSink = (value: ProtocolDiagnostic) => void

function emitDiagnostic(
  config: ResolvedConfig,
  diagnostic: DiagnosticSink | undefined,
  level: ProtocolDiagnostic['level'],
  method: string,
  message: string | undefined,
): void {
  if (message === undefined) return
  diagnostic?.({ level, method, message: redactDiagnostic(message, Math.min(config.stderrMaxBytes, 4_096)) })
}

function routeErrorDiagnostic(
  active: ActiveTurn | undefined,
  config: ResolvedConfig,
  method: string,
  params: unknown,
  diagnostic: DiagnosticSink | undefined,
): void {
  if (active === undefined || requireActiveRoute(active, params) === undefined) return
  const willRetry = (params as Record<string, unknown>)['willRetry'] === true
  const message = diagnosticMessage(params, 'message') ?? 'Codex turn failed'
  emitDiagnostic(config, diagnostic, willRetry ? 'warn' : 'error', method, message)
  if (!willRetry) active.completion.reject(new CodexAppServerError('PROTOCOL_INVALID', message))
}

function routeWarningDiagnostic(
  active: ActiveTurn | undefined,
  config: ResolvedConfig,
  method: string,
  params: unknown,
  diagnostic: DiagnosticSink | undefined,
): void {
  const value = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
  const threadId = value['threadId']
  if (threadId !== null && threadId !== undefined && threadId !== active?.threadId) return
  emitDiagnostic(config, diagnostic, 'warn', method, diagnosticMessage(params, 'message'))
}

function routeModelDiagnostic(
  active: ActiveTurn | undefined,
  config: ResolvedConfig,
  method: string,
  params: unknown,
  diagnostic: DiagnosticSink | undefined,
): void {
  if (active === undefined || requireActiveRoute(active, params) === undefined) return
  const value = params as Record<string, unknown>
  emitDiagnostic(
    config,
    diagnostic,
    'info',
    method,
    `model rerouted from ${String(value['fromModel'])} to ${String(value['toModel'])}`,
  )
}

function routeDiagnostic(
  active: ActiveTurn | undefined,
  config: ResolvedConfig,
  method: string,
  params: unknown,
  diagnostic: DiagnosticSink | undefined,
): boolean {
  switch (method) {
    case 'error':
      routeErrorDiagnostic(active, config, method, params, diagnostic)
      return true
    case 'warning':
      routeWarningDiagnostic(active, config, method, params, diagnostic)
      return true
    case 'deprecationNotice':
    case 'configWarning':
      emitDiagnostic(config, diagnostic, 'warn', method, diagnosticMessage(params, 'summary', 'message'))
      return true
    case 'model/rerouted':
      routeModelDiagnostic(active, config, method, params, diagnostic)
      return true
    default:
      return false
  }
}

function routeObservedTurnState(active: ActiveTurn | undefined, method: string, params: unknown): boolean {
  if (method !== 'turn/diff/updated' && method !== 'turn/plan/updated') return false
  if (active !== undefined) requireActiveRoute(active, params)
  return true
}

function routeItemLifecycle(active: ActiveTurn, method: string, params: unknown): boolean {
  if (method !== 'item/started' && method !== 'item/completed') return false
  const notification = parseItemNotification(params)
  if (!matches(active, notification.threadId, notification.turnId)) return true
  if (method === 'item/started') active.callbacks.itemStarted?.(notification.item)
  else active.callbacks.itemCompleted?.(notification.item)
  return true
}

function deliverDelta(active: ActiveTurn, params: unknown, deliver: (itemId: string, delta: string) => void): void {
  if (requireActiveRoute(active, params) === undefined) return
  const value = params as Record<string, unknown>
  if (typeof value['itemId'] === 'string' && typeof value['delta'] === 'string') {
    deliver(value['itemId'], value['delta'])
  }
}

function routeDelta(active: ActiveTurn, method: string, params: unknown): boolean {
  const routes: Record<string, (itemId: string, delta: string) => void> = {
    'item/agentMessage/delta': (itemId, delta) => active.callbacks.agentMessageDelta?.(itemId, delta),
    'item/reasoning/summaryTextDelta': (itemId, delta) => active.callbacks.reasoningDelta?.(itemId, delta, 'summary'),
    'item/reasoning/textDelta': (itemId, delta) => active.callbacks.reasoningDelta?.(itemId, delta, 'content'),
    'item/commandExecution/outputDelta': (itemId, delta) => active.callbacks.commandOutputDelta?.(itemId, delta),
  }
  const deliver = routes[method]
  if (deliver === undefined) return false
  deliverDelta(active, params, deliver)
  return true
}

/** Route one notification to the sole active turn, isolating unrelated ids. */
export function routeNotification(
  active: ActiveTurn | undefined,
  config: ResolvedConfig,
  method: string,
  params: unknown,
  diagnostic?: (value: ProtocolDiagnostic) => void,
): void {
  if (routeDiagnostic(active, config, method, params, diagnostic)) return
  if (routeObservedTurnState(active, method, params)) return
  if (active === undefined) return
  routeActiveNotification(active, config, method, params)
}

function routeActiveNotification(active: ActiveTurn, config: ResolvedConfig, method: string, params: unknown): void {
  if (routeTurnLifecycle(active, method, params)) return
  if (routeItemLifecycle(active, method, params)) return
  if (routeDelta(active, method, params)) return
  if (method === 'thread/tokenUsage/updated') {
    if (requireActiveRoute(active, params) !== undefined) active.callbacks.usage?.(params)
    return
  }
  active.callbacks.unknownNotification?.(method, params)
  if (config.unknownNotificationPolicy === 'fail-turn') {
    active.completion.reject(new CodexAppServerError('PROTOCOL_INVALID', `unknown notification ${method}`))
  }
}
