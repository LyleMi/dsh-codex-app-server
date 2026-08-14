import type { ResolvedConfig } from '../config.js'
import { CodexAppServerError } from '../errors.js'
import type { CodexProcess } from '../process.js'
import type { JsonRpcRequest, ThreadValue, TurnValue } from './protocol.js'
import { parseInitializeResult, parseThreadResult, parseTurnStartResult } from './protocol.js'
import { AppServerTransport } from './transport.js'
import type { ActiveTurn, TurnCallbacks } from './notifications.js'
import { requireActiveRoute, routeNotification } from './notifications.js'

export type { TurnCallbacks } from './notifications.js'

export interface ThreadBinding {
  thread: ThreadValue
  model: string
  modelProvider: string
  cwd: string
}

export type ServerRequestHandler = (request: JsonRpcRequest) => Promise<unknown>

/** Typed client for the stable App Server operations used by the Agent driver. */
export class AppServerClient {
  private readonly transport: AppServerTransport
  private activeTurn: ActiveTurn | undefined
  private binding: ThreadBinding | undefined

  constructor(
    private readonly process: CodexProcess,
    private readonly config: ResolvedConfig,
    private readonly handleServerRequest: ServerRequestHandler,
  ) {
    this.transport = new AppServerTransport(process.child.stdout, process.child.stdin, config.requestIdleTimeoutMs, {
      notification: (message) => routeNotification(this.activeTurn, this.config, message.method, message.params),
      request: (request) => this.onServerRequest(request),
      protocolError: () => {},
    })
    void process.exited.then(({ code, signal }) => {
      const error = new CodexAppServerError(
        'PROCESS_EXITED',
        `Codex App Server exited unexpectedly (code ${String(code)}, signal ${String(signal)})${process.diagnostic === '' ? '' : `: ${process.diagnostic}`}`,
      )
      this.activeTurn?.completion.reject(error)
      this.transport.close(error)
    })
  }

  /** Perform the mandatory initialize/initialized handshake. */
  async initialize(): Promise<{
    userAgent: string
    platformFamily: string
    platformOs: string
  }> {
    const value = await this.transport.request(
      'initialize',
      {
        clientInfo: {
          name: 'dsh-codex-app-server',
          title: 'DSH Codex App Server',
          version: '0.1.0-beta.0',
        },
        capabilities: { experimentalApi: false },
      },
      this.config.startupTimeoutMs,
    )
    const result = parseInitializeResult(value)
    this.transport.notify('initialized')
    return result
  }

  /** Start a persistent Codex thread in the validated DSH workspace. */
  async startThread(cwd: string): Promise<ThreadBinding> {
    if (this.binding !== undefined) throw new CodexAppServerError('PROTOCOL_INVALID', 'client already owns a thread')
    const result = parseThreadResult(
      await this.transport.request('thread/start', {
        ...(this.config.model === undefined ? {} : { model: this.config.model }),
        cwd,
        approvalPolicy: this.config.approvalPolicy,
        sandbox: this.config.sandboxMode,
        ephemeral: false,
        historyMode: 'full',
      }),
    )
    this.assertWorkspace(cwd, result.cwd)
    this.binding = result
    return result
  }

  /** Resume one exact persisted Codex thread; never creates a replacement. */
  async resumeThread(threadId: string, cwd: string): Promise<ThreadBinding> {
    if (this.binding !== undefined) throw new CodexAppServerError('PROTOCOL_INVALID', 'client already owns a thread')
    const result = parseThreadResult(
      await this.transport.request('thread/resume', {
        threadId,
        ...(this.config.model === undefined ? {} : { model: this.config.model }),
        cwd,
        approvalPolicy: this.config.approvalPolicy,
        sandbox: this.config.sandboxMode,
      }),
    )
    if (result.thread.id !== threadId) {
      throw new CodexAppServerError(
        'THREAD_MISMATCH',
        `thread/resume returned ${result.thread.id} instead of ${threadId}`,
      )
    }
    this.assertWorkspace(cwd, result.cwd)
    this.binding = result
    return result
  }

  /** Run the sole active turn and settle only on its correlated completion notification. */
  async startTurn(input: string, callbacks: TurnCallbacks = {}): Promise<TurnValue> {
    const binding = this.binding
    if (binding === undefined) throw new CodexAppServerError('PROTOCOL_INVALID', 'thread has not been started')
    if (this.activeTurn !== undefined) throw new CodexAppServerError('PROTOCOL_INVALID', 'a turn is already active')
    const completion = Promise.withResolvers<TurnValue>()
    const active: ActiveTurn = {
      threadId: binding.thread.id,
      callbacks,
      completion,
    }
    this.activeTurn = active
    try {
      const started = parseTurnStartResult(
        await this.transport.request('turn/start', {
          threadId: binding.thread.id,
          input: [{ type: 'text', text: input, text_elements: [] }],
          ...(this.config.model === undefined ? {} : { model: this.config.model }),
          ...(this.config.reasoningEffort === undefined ? {} : { effort: this.config.reasoningEffort }),
        }),
      )
      if (active.turnId !== undefined && active.turnId !== started.id) {
        throw new CodexAppServerError('THREAD_MISMATCH', 'turn/start response disagrees with early turn notification')
      }
      active.turnId = started.id
      return await completion.promise
    } finally {
      if (this.activeTurn === active) this.activeTurn = undefined
    }
  }

  /** Interrupt the active correlated Codex turn. */
  async interrupt(): Promise<void> {
    const active = this.activeTurn
    if (active?.turnId === undefined) return
    await this.transport.request(
      'turn/interrupt',
      { threadId: active.threadId, turnId: active.turnId },
      this.config.interruptGraceMs,
    )
  }

  /** Reject protocol work before the process owner terminates the child. */
  close(): void {
    this.transport.close()
  }

  private assertWorkspace(expected: string, actual: string): void {
    if (expected !== actual) {
      throw new CodexAppServerError(
        'THREAD_MISMATCH',
        `App Server cwd ${JSON.stringify(actual)} does not match session cwd`,
      )
    }
  }

  private async onServerRequest(request: JsonRpcRequest): Promise<unknown> {
    const known = new Set([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/tool/requestUserInput',
      'item/permissions/requestApproval',
      'mcpServer/elicitation/request',
    ])
    if (!known.has(request.method)) {
      this.activeTurn?.completion.reject(
        new CodexAppServerError('UNKNOWN_SERVER_REQUEST', `unsupported App Server request ${request.method}`),
      )
      throw new CodexAppServerError('UNKNOWN_SERVER_REQUEST', `unsupported App Server request ${request.method}`)
    }
    const active = requireActiveRoute(this.activeTurn, request.params)
    if (active === undefined) throw new CodexAppServerError('THREAD_MISMATCH', 'server request belongs to another turn')
    return this.handleServerRequest(request)
  }
}
