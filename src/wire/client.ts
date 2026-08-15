import type { ResolvedConfig } from '../config.js'
import { CodexAppServerError } from '../errors.js'
import { packageVersion } from '../package.js'
import type { CodexProcess } from '../process.js'
import type { JsonRpcRequest, ThreadValue, TurnInput, TurnValue } from './protocol.js'
import { parseInitializeResult, parseThreadResult, parseTurnStartResult } from './protocol.js'
import { AppServerTransport } from './transport.js'
import type { ActiveTurn, ProtocolDiagnostic, TurnCallbacks } from './notifications.js'
import { requireActiveRoute, routeNotification } from './notifications.js'
import { TurnWatchdog } from './watchdog.js'

export type { TurnCallbacks } from './notifications.js'

export interface ThreadBinding {
  thread: ThreadValue
  model: string
  modelProvider: string
  cwd: string
}

export type ServerRequestHandler = (request: JsonRpcRequest) => Promise<unknown>

export const SUPPORTED_SERVER_REQUEST_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
] as const

const supportedServerRequests = new Set<string>(SUPPORTED_SERVER_REQUEST_METHODS)

type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite'
      writableRoots: string[]
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }

/** Typed client for the stable App Server operations used by the Agent driver. */
export class AppServerClient {
  private readonly transport: AppServerTransport
  private activeTurn: ActiveTurn | undefined
  private binding: ThreadBinding | undefined
  private interruptPending = false
  private readonly watchdog: TurnWatchdog

  constructor(
    private readonly process: CodexProcess,
    private readonly config: ResolvedConfig,
    private readonly handleServerRequest: ServerRequestHandler,
    private readonly handleDiagnostic: (diagnostic: ProtocolDiagnostic) => void = () => {},
  ) {
    this.watchdog = new TurnWatchdog(config.turnIdleTimeoutMs, config.interruptGraceMs)
    this.transport = new AppServerTransport(
      process.child.stdout,
      process.child.stdin,
      config.requestIdleTimeoutMs,
      {
        notification: (message) => this.receiveNotification(message.method, message.params),
        request: (request) => this.onServerRequest(request),
        protocolError: (error) => this.activeTurn?.completion.reject(error),
      },
      config.protocolMaxBytes,
    )
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
          version: packageVersion,
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
      }),
    )
    assertWorkspace(cwd, result.cwd)
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
    assertWorkspace(cwd, result.cwd)
    this.binding = result
    return result
  }

  /** Run the sole active turn and settle only on its correlated completion notification. */
  async startTurn(input: string | readonly TurnInput[], callbacks: TurnCallbacks = {}): Promise<TurnValue> {
    const binding = this.binding
    if (binding === undefined) throw new CodexAppServerError('PROTOCOL_INVALID', 'thread has not been started')
    if (this.activeTurn !== undefined) throw new CodexAppServerError('PROTOCOL_INVALID', 'a turn is already active')
    const completion = Promise.withResolvers<TurnValue>()
    const active: ActiveTurn = {
      threadId: binding.thread.id,
      callbacks,
      completion,
      turnReady: Promise.withResolvers<void>(),
      activity: () => this.touchTurn(active),
    }
    this.activeTurn = active
    this.interruptPending = false
    try {
      const started = parseTurnStartResult(
        await this.transport.request('turn/start', {
          threadId: binding.thread.id,
          input: normalizeTurnInput(input),
          sandboxPolicy: turnSandboxPolicy(this.config, binding.cwd),
          ...(this.config.model === undefined ? {} : { model: this.config.model }),
          ...(this.config.reasoningEffort === undefined ? {} : { effort: this.config.reasoningEffort }),
        }),
      )
      if (active.turnId !== undefined && active.turnId !== started.id) {
        throw new CodexAppServerError('THREAD_MISMATCH', 'turn/start response disagrees with early turn notification')
      }
      active.turnId = started.id
      active.turnReady.resolve()
      this.touchTurn(active)
      if (this.interruptPending) {
        this.interruptPending = false
        await this.sendInterrupt(active)
        this.armDeadline(active, 'INTERRUPT_TIMEOUT', 'Codex turn did not complete after interrupt')
      }
      return await completion.promise
    } finally {
      this.watchdog.clear()
      active.turnReady.resolve()
      this.interruptPending = false
      if (this.activeTurn === active) this.activeTurn = undefined
    }
  }

  /** Interrupt the active correlated Codex turn. */
  async interrupt(): Promise<void> {
    const active = this.activeTurn
    if (active === undefined) return
    this.interruptPending = true
    if (active.turnId === undefined) return
    this.interruptPending = false
    try {
      await this.sendInterrupt(active)
    } catch (error: unknown) {
      const failure = turnTimeout('INTERRUPT_TIMEOUT', 'Codex interrupt request did not complete', error)
      await this.forceTurnFailure(active, failure)
      throw failure
    }
    this.armDeadline(active, 'INTERRUPT_TIMEOUT', 'Codex turn did not complete after interrupt')
  }

  private async sendInterrupt(active: ActiveTurn): Promise<void> {
    if (active.turnId === undefined) return
    await this.transport.request(
      'turn/interrupt',
      { threadId: active.threadId, turnId: active.turnId },
      this.config.interruptGraceMs,
    )
  }

  /** Add model-visible input to the active turn at App Server's native steer boundary. */
  async steer(input: string | readonly TurnInput[]): Promise<void> {
    const active = this.activeTurn
    if (active === undefined) throw new CodexAppServerError('PROTOCOL_INVALID', 'no active turn to steer')
    await active.turnReady.promise
    if (this.activeTurn !== active || active.turnId === undefined) {
      throw new CodexAppServerError('PROTOCOL_INVALID', 'active turn ended before it could be steered')
    }
    await this.transport.request('turn/steer', {
      threadId: active.threadId,
      expectedTurnId: active.turnId,
      input: normalizeTurnInput(input),
    })
  }

  /** Reject protocol work before the process owner terminates the child. */
  close(): void {
    this.transport.close()
  }

  private receiveNotification(method: string, params: unknown): void {
    const active = this.activeTurn
    routeNotification(active, this.config, method, params, this.handleDiagnostic)
    if (this.interruptPending && active?.turnId !== undefined) {
      this.interruptPending = false
      void this.sendInterrupt(active).then(
        () => this.armDeadline(active, 'INTERRUPT_TIMEOUT', 'Codex turn did not complete after interrupt'),
        (error) =>
          this.forceTurnFailure(
            active,
            turnTimeout('INTERRUPT_TIMEOUT', 'Codex interrupt request did not complete', error),
          ),
      )
    }
  }

  private touchTurn(active: ActiveTurn): void {
    if (this.activeTurn !== active || active.turnId === undefined) return
    this.watchdog.touch(() => {
      void this.sendInterrupt(active).then(
        () =>
          this.armDeadline(
            active,
            'TURN_IDLE_TIMEOUT',
            `Codex turn was idle for ${this.config.turnIdleTimeoutMs}ms and did not stop after interrupt`,
          ),
        (error) =>
          this.forceTurnFailure(
            active,
            turnTimeout('TURN_IDLE_TIMEOUT', 'Codex idle-turn interrupt request did not complete', error),
          ),
      )
    })
  }

  private armDeadline(active: ActiveTurn, code: 'TURN_IDLE_TIMEOUT' | 'INTERRUPT_TIMEOUT', message: string): void {
    if (this.activeTurn !== active) return
    this.watchdog.armDeadline(() => {
      void this.forceTurnFailure(active, new CodexAppServerError(code, message))
    })
  }

  private async forceTurnFailure(active: ActiveTurn, error: unknown): Promise<void> {
    if (this.activeTurn !== active) return
    active.completion.reject(error)
    this.transport.close(error)
    await this.process.dispose().catch(() => {})
  }

  private async onServerRequest(request: JsonRpcRequest): Promise<unknown> {
    return routeServerRequest(this.activeTurn, this.handleServerRequest, request)
  }
}

function assertWorkspace(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new CodexAppServerError(
      'THREAD_MISMATCH',
      `App Server cwd ${JSON.stringify(actual)} does not match session cwd`,
    )
  }
}

async function routeServerRequest(
  activeTurn: ActiveTurn | undefined,
  handler: ServerRequestHandler,
  request: JsonRpcRequest,
): Promise<unknown> {
  if (!supportedServerRequests.has(request.method)) {
    const error = new CodexAppServerError('UNKNOWN_SERVER_REQUEST', `unsupported App Server request ${request.method}`)
    activeTurn?.completion.reject(error)
    throw error
  }
  const active = requireActiveRoute(activeTurn, request.params)
  if (active === undefined) throw new CodexAppServerError('THREAD_MISMATCH', 'server request belongs to another turn')
  try {
    return await handler(request)
  } catch (error: unknown) {
    active.completion.reject(error)
    throw error
  }
}

function turnTimeout(
  code: 'TURN_IDLE_TIMEOUT' | 'INTERRUPT_TIMEOUT',
  message: string,
  cause: unknown,
): CodexAppServerError {
  return new CodexAppServerError(code, message, { cause })
}

function normalizeTurnInput(input: string | readonly TurnInput[]): readonly TurnInput[] {
  return typeof input === 'string' ? [{ type: 'text', text: input, text_elements: [] }] : input
}

function turnSandboxPolicy(config: ResolvedConfig, cwd: string): SandboxPolicy {
  if (config.sandboxMode === 'danger-full-access') return { type: 'dangerFullAccess' }
  const networkAccess = config.networkAccess ?? false
  if (config.sandboxMode === 'read-only') return { type: 'readOnly', networkAccess }
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}
