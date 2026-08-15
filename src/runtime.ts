import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ResolvedConfig } from './config.js'
import { CodexAppServerError } from './errors.js'
import { CodexProcess } from './process.js'
import type { ServerRequestHandler, ThreadBinding, TurnCallbacks } from './wire/client.js'
import { AppServerClient } from './wire/client.js'
import type { ProtocolDiagnostic } from './wire/notifications.js'
import type { JsonRpcRequest, TurnInput, TurnValue } from './wire/protocol.js'

export interface CodexConnection {
  process: { dispose(): Promise<void> }
  client: {
    initialize(): Promise<unknown>
    startThread(cwd: string): Promise<ThreadBinding>
    resumeThread(threadId: string, cwd: string): Promise<ThreadBinding>
    startTurn(input: readonly TurnInput[], callbacks?: TurnCallbacks): Promise<TurnValue>
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
  private readonly launcher: CodexConnectionLauncher
  private readonly serverRequestHandler: ServerRequestHandler
  private readonly protocolDiagnostic: (value: ProtocolDiagnostic) => void

  constructor(
    private readonly config: ResolvedConfig,
    private readonly cwd: string,
    private readonly options: AgentOptions,
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

  async connect(resumeThreadId?: string, seedContext?: string): Promise<ThreadBinding> {
    if (this.connection !== undefined) throw new Error('Codex runtime is already connected')
    const connection = (this.connection = this.launch())
    try {
      await connection.client.initialize()
      this.thread =
        resumeThreadId === undefined
          ? await connection.client.startThread(this.cwd)
          : await connection.client.resumeThread(resumeThreadId, this.cwd)
      if (resumeThreadId === undefined) this.pendingSeed = seedContext
      return this.thread
    } catch (error: unknown) {
      await this.resetConnection(connection)
      throw error
    }
  }

  async startTurn(input: readonly TurnInput[], callbacks: TurnCallbacks): Promise<TurnValue> {
    const seed = this.pendingSeed
    this.pendingSeed = undefined
    const prompt: readonly TurnInput[] =
      seed === undefined
        ? input
        : [{ type: 'text', text: `${seed}\n\nCurrent user input:`, text_elements: [] }, ...input]
    const connection = await this.ensureConnection()
    try {
      return await connection.client.startTurn(prompt, callbacks)
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

  async shutdown(): Promise<void> {
    if (this.connection === undefined) return
    await this.resetConnection(this.connection)
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
      this.thread = await connection.client.resumeThread(thread.thread.id, this.cwd)
      return connection
    } catch (error: unknown) {
      await this.resetConnection(connection)
      throw error
    }
  }

  private launch(): CodexConnection {
    const effectiveConfig: ResolvedConfig = {
      ...this.config,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
    }
    return this.launcher(effectiveConfig, this.cwd, this.serverRequestHandler, this.protocolDiagnostic)
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
