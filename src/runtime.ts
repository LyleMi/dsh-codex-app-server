import type { ResolvedConfig } from './config.js'
import { CodexAppServerError } from './errors.js'
import { CodexProcess } from './process.js'
import type { CodexTurnSelection, ServerRequestHandler, ThreadBinding, TurnCallbacks } from './wire/client.js'
import { AppServerClient } from './wire/client.js'
import type { ProtocolDiagnostic } from './wire/notifications.js'
import type { JsonRpcRequest, TurnInput, TurnValue } from './wire/protocol.js'
import type { CodexBridgeSnapshot } from './bridge.js'

export interface CodexConnection {
  process: { dispose(): Promise<void> }
  client: {
    initialize(): Promise<unknown>
    startThread(cwd: string, selection?: CodexTurnSelection, bridge?: CodexBridgeSnapshot): Promise<ThreadBinding>
    resumeThread(
      threadId: string,
      cwd: string,
      selection?: CodexTurnSelection,
      bridge?: CodexBridgeSnapshot,
    ): Promise<ThreadBinding>
    startTurn(
      input: readonly TurnInput[],
      callbacks?: TurnCallbacks,
      selection?: CodexTurnSelection,
    ): Promise<TurnValue>
    compactThread(callbacks?: TurnCallbacks): Promise<TurnValue>
    steer(input: readonly TurnInput[]): Promise<void>
    interrupt(): Promise<void>
    close(): void
  }
}

export type CodexConnectionLauncher = (
  config: ResolvedConfig,
  cwd: string,
  handler: ServerRequestHandler,
  diagnostic?: (value: ProtocolDiagnostic) => void,
) => CodexConnection

export interface CodexRuntimeHooks {
  launcher?: CodexConnectionLauncher
  serverRequestHandler?: ServerRequestHandler
  protocolDiagnostic?: (value: ProtocolDiagnostic) => void
}

/** Owns the process, protocol client, one thread, and fail-closed unattended decisions. */
export class CodexRuntime {
  private connection: CodexConnection | undefined
  private thread: ThreadBinding | undefined
  private pendingSeed: string | undefined
  private selection: CodexTurnSelection | undefined
  private bridge: CodexBridgeSnapshot | undefined
  private readonly launcher: CodexConnectionLauncher
  private readonly serverRequestHandler: ServerRequestHandler
  private readonly protocolDiagnostic: (value: ProtocolDiagnostic) => void

  constructor(
    private readonly config: ResolvedConfig,
    private readonly cwd: string,
    hooks: CodexRuntimeHooks = {},
  ) {
    this.launcher = hooks.launcher ?? defaultConnectionLauncher
    this.serverRequestHandler = hooks.serverRequestHandler ?? unattendedServerRequest
    this.protocolDiagnostic = hooks.protocolDiagnostic ?? (() => {})
  }

  get binding(): ThreadBinding {
    if (this.thread === undefined) throw new Error('Codex thread is not connected')
    return this.thread
  }

  async connect(
    resumeThreadId?: string,
    seedContext?: string,
    selection?: CodexTurnSelection,
    bridge?: CodexBridgeSnapshot,
  ): Promise<ThreadBinding> {
    if (this.connection !== undefined) throw new Error('Codex runtime is already connected')
    const connection = (this.connection = this.launch())
    try {
      await connection.client.initialize()
      this.selection = selection
      this.bridge = bridge
      this.thread =
        resumeThreadId === undefined
          ? await connection.client.startThread(this.cwd, selection, bridge)
          : await connection.client.resumeThread(resumeThreadId, this.cwd, selection, bridge)
      if (resumeThreadId === undefined) this.pendingSeed = seedContext
      return this.thread
    } catch (error: unknown) {
      await this.resetConnection(connection)
      throw error
    }
  }

  async startTurn(
    input: readonly TurnInput[],
    callbacks: TurnCallbacks,
    selection?: CodexTurnSelection,
    bridge?: CodexBridgeSnapshot,
  ): Promise<TurnValue> {
    const seed = this.pendingSeed
    this.pendingSeed = undefined
    const prompt: readonly TurnInput[] =
      seed === undefined
        ? input
        : [{ type: 'text', text: `${seed}\n\nCurrent user input:`, text_elements: [] }, ...input]
    await this.refreshBridge(bridge)
    const connection = await this.ensureConnection()
    this.selection = selection
    try {
      return selection === undefined
        ? await connection.client.startTurn(prompt, callbacks)
        : await connection.client.startTurn(prompt, callbacks, selection)
    } catch (error: unknown) {
      if (
        error instanceof CodexAppServerError &&
        (error.code === 'TURN_IDLE_TIMEOUT' || error.code === 'INTERRUPT_TIMEOUT')
      ) {
        await this.resetConnection(connection)
      }
      throw error
    }
  }

  steer(input: readonly TurnInput[]): Promise<void> {
    return this.requireConnection().client.steer(input)
  }

  interrupt(): Promise<void> {
    return this.connection?.client.interrupt() ?? Promise.resolve()
  }

  async compact(signal: AbortSignal): Promise<TurnValue> {
    const connection = await this.ensureConnection()
    const interrupt = (): void => {
      void connection.client.interrupt().catch(() => {})
    }
    signal.addEventListener('abort', interrupt, { once: true })
    try {
      signal.throwIfAborted()
      return await connection.client.compactThread()
    } finally {
      signal.removeEventListener('abort', interrupt)
    }
  }

  async shutdown(): Promise<void> {
    if (this.connection === undefined) return
    await this.resetConnection(this.connection)
  }

  private async refreshBridge(bridge: CodexBridgeSnapshot | undefined): Promise<void> {
    if (bridge?.fingerprint === this.bridge?.fingerprint) return
    if (this.connection !== undefined) await this.resetConnection(this.connection)
    this.bridge = bridge
  }

  private requireConnection(): CodexConnection {
    if (this.connection === undefined) throw new Error('Codex runtime is not connected')
    return this.connection
  }

  private async ensureConnection(): Promise<CodexConnection> {
    if (this.connection !== undefined) return this.connection
    const thread = this.thread
    if (thread === undefined) throw new Error('Codex thread is not connected')
    const connection = (this.connection = this.launch())
    try {
      await connection.client.initialize()
      this.thread = await connection.client.resumeThread(thread.thread.id, this.cwd, this.selection, this.bridge)
      return connection
    } catch (error: unknown) {
      await this.resetConnection(connection)
      throw error
    }
  }

  private launch(): CodexConnection {
    return this.launcher(this.config, this.cwd, this.serverRequestHandler, this.protocolDiagnostic)
  }

  private async resetConnection(connection: CodexConnection): Promise<void> {
    if (this.connection === connection) this.connection = undefined
    connection.client.close()
    await connection.process.dispose()
  }
}

function unattendedServerRequest(request: JsonRpcRequest): Promise<unknown> {
  if (
    request.method === 'item/commandExecution/requestApproval' ||
    request.method === 'item/fileChange/requestApproval'
  ) {
    return Promise.resolve({ decision: 'decline' })
  }
  if (request.method === 'item/tool/requestUserInput') return Promise.resolve({ answers: {} })
  if (request.method === 'mcpServer/elicitation/request') {
    return Promise.resolve({ action: 'decline', content: null, _meta: null })
  }
  return Promise.reject(new Error(`no safe unattended response for ${request.method}`))
}

function defaultConnectionLauncher(
  config: ResolvedConfig,
  cwd: string,
  handler: ServerRequestHandler,
  diagnostic: (value: ProtocolDiagnostic) => void = () => {},
): CodexConnection {
  const child = new CodexProcess(config, cwd)
  return { process: child, client: new AppServerClient(child, config, handler, diagnostic) }
}
