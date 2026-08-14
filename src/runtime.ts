import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ResolvedConfig } from './config.js'
import { CodexProcess } from './process.js'
import type { ServerRequestHandler, ThreadBinding, TurnCallbacks } from './wire/client.js'
import { AppServerClient } from './wire/client.js'
import type { JsonRpcRequest, TurnValue } from './wire/protocol.js'

export interface CodexConnection {
  process: { dispose(): Promise<void> }
  client: {
    initialize(): Promise<unknown>
    startThread(cwd: string): Promise<ThreadBinding>
    resumeThread(threadId: string, cwd: string): Promise<ThreadBinding>
    startTurn(input: string, callbacks?: TurnCallbacks): Promise<TurnValue>
    steer(input: string): Promise<void>
    interrupt(): Promise<void>
    close(): void
  }
}

export type CodexConnectionLauncher = (
  config: ResolvedConfig,
  cwd: string,
  handler: ServerRequestHandler,
) => CodexConnection

/** Owns the process, protocol client, one thread, and fail-closed unattended decisions. */
export class CodexRuntime {
  private connection: CodexConnection | undefined
  private thread: ThreadBinding | undefined
  private pendingSeed: string | undefined

  constructor(
    private readonly config: ResolvedConfig,
    private readonly cwd: string,
    private readonly options: AgentOptions,
    private readonly launcher: CodexConnectionLauncher = defaultConnectionLauncher,
    private readonly serverRequestHandler: ServerRequestHandler = unattendedServerRequest,
  ) {}

  get binding(): ThreadBinding {
    if (this.thread === undefined) throw new Error('Codex thread is not connected')
    return this.thread
  }

  async connect(resumeThreadId?: string, seedContext?: string): Promise<ThreadBinding> {
    if (this.connection !== undefined) throw new Error('Codex runtime is already connected')
    const effectiveConfig: ResolvedConfig = {
      ...this.config,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
    }
    const connection = (this.connection = this.launcher(effectiveConfig, this.cwd, this.serverRequestHandler))
    try {
      await connection.client.initialize()
      this.thread =
        resumeThreadId === undefined
          ? await connection.client.startThread(this.cwd)
          : await connection.client.resumeThread(resumeThreadId, this.cwd)
      if (resumeThreadId === undefined) this.pendingSeed = seedContext
      return this.thread
    } catch (error: unknown) {
      connection.client.close()
      await connection.process.dispose()
      throw error
    }
  }

  startTurn(input: string, callbacks: TurnCallbacks): Promise<TurnValue> {
    const seed = this.pendingSeed
    this.pendingSeed = undefined
    const prompt = seed === undefined ? input : `${seed}\n\nCurrent user input:\n${input}`
    return this.requireConnection().client.startTurn(prompt, callbacks)
  }

  steer(input: string): Promise<void> {
    return this.requireConnection().client.steer(input)
  }

  interrupt(): Promise<void> {
    return this.connection?.client.interrupt() ?? Promise.resolve()
  }

  async shutdown(): Promise<void> {
    if (this.connection === undefined) return
    this.connection.client.close()
    await this.connection.process.dispose()
  }

  private requireConnection(): CodexConnection {
    if (this.connection === undefined) throw new Error('Codex runtime is not connected')
    return this.connection
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
): CodexConnection {
  const child = new CodexProcess(config, cwd)
  return { process: child, client: new AppServerClient(child, config, handler) }
}
