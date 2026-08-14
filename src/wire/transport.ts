import type { Readable, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import { CodexAppServerError } from '../errors.js'
import type { JsonRpcId, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from './protocol.js'
import { parseJsonRpc } from './protocol.js'

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: unknown): void
  timer: NodeJS.Timeout
}

export interface TransportHandlers {
  notification(message: { method: string; params?: unknown }): void
  request(message: JsonRpcRequest): Promise<unknown>
  protocolError(error: unknown): void
}

/** Newline-delimited JSON-RPC transport with request correlation and fail-closed server requests. */
export class AppServerTransport {
  private nextId = 1
  private pending = new Map<JsonRpcId, PendingRequest>()
  private closed = false
  private readonly lines

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly timeoutMs: number,
    private readonly handlers: TransportHandlers,
  ) {
    this.lines = createInterface({ input, crlfDelay: Infinity })
    this.lines.on('line', (line) => {
      if (line.length === 0) return
      try {
        this.receive(parseJsonRpc(line))
      } catch (error: unknown) {
        handlers.protocolError(error)
        this.close(error)
      }
    })
    this.lines.on('close', () => this.close(new CodexAppServerError('PROTOCOL_CLOSED', 'App Server stdout closed')))
    input.on('error', (error) => this.close(error))
    output.on('error', (error) => this.close(error))
  }

  /** Send one client request and await its correlated result. */
  request(method: string, params?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodexAppServerError('PROTOCOL_CLOSED', 'App Server transport is closed'))
    const id = this.nextId++
    const result = Promise.withResolvers<unknown>()
    const timer = setTimeout(() => {
      this.pending.delete(id)
      result.reject(new CodexAppServerError('REQUEST_TIMEOUT', `${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()
    this.pending.set(id, { ...result, timer })
    try {
      this.write({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      })
    } catch (error: unknown) {
      clearTimeout(timer)
      this.pending.delete(id)
      result.reject(error)
    }
    return result.promise
  }

  /** Send a notification without allocating a request id. */
  notify(method: string, params?: unknown): void {
    if (this.closed) throw new CodexAppServerError('PROTOCOL_CLOSED', 'App Server transport is closed')
    this.write({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    })
  }

  /** Reject all outstanding work and stop accepting frames. */
  close(reason: unknown = new CodexAppServerError('PROTOCOL_CLOSED', 'App Server transport closed')): void {
    if (this.closed) return
    this.closed = true
    this.lines.close()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.pending.clear()
  }

  private write(message: object): void {
    this.output.write(`${JSON.stringify(message)}\n`)
  }

  private receive(message: JsonRpcMessage): void {
    if ('method' in message) {
      if ('id' in message) void this.answerServerRequest(message)
      else this.handlers.notification(message)
      return
    }
    this.answerClientRequest(message)
  }

  private answerClientRequest(message: JsonRpcResponse): void {
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error !== undefined) {
      pending.reject(
        new CodexAppServerError('PROTOCOL_INVALID', `App Server error ${message.error.code}: ${message.error.message}`),
      )
    } else {
      pending.resolve(message.result)
    }
  }

  private async answerServerRequest(message: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.handlers.request(message)
      this.write({ jsonrpc: '2.0', id: message.id, result })
    } catch (error: unknown) {
      const safe = error instanceof Error ? error.message : 'server request rejected'
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32_601, message: safe },
      })
    }
  }
}
