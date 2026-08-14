import type { ResolvedConfig } from '../config.js'
import { CodexAppServerError } from '../errors.js'
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

export interface ActiveTurn {
  threadId: string
  turnId?: string
  callbacks: TurnCallbacks
  completion: PromiseWithResolvers<TurnValue>
  turnReady: PromiseWithResolvers<void>
}

function matches(active: ActiveTurn, threadId: string, turnId: string): boolean {
  if (threadId !== active.threadId) return false
  if (active.turnId === undefined) {
    active.turnId = turnId
    active.turnReady.resolve()
  }
  return active.turnId === turnId
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
  if (method === 'turn/completed') active.completion.resolve(turn)
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
): void {
  if (active === undefined) return
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
