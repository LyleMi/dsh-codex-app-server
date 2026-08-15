import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from './config.js'
import { CodexAppServerError } from './errors.js'
import { CodexProcess } from './process.js'
import { AppServerClient } from './wire/client.js'
import type { CodexModelInfo } from './wire/protocol.js'

export const CODEX_PROVIDER = 'codex-app-server'

/** Cached account-scoped catalog discovered from the official Codex App Server. */
export class CodexModelCatalog {
  private cached: Promise<readonly CodexModelInfo[]> | undefined

  constructor(
    private readonly config: ResolvedConfig,
    private readonly cwd: string,
  ) {}

  list(): Promise<readonly CodexModelInfo[]> {
    this.cached ??= this.discover().catch((error: unknown) => {
      this.cached = undefined
      throw error
    })
    return this.cached
  }

  private async discover(): Promise<readonly CodexModelInfo[]> {
    const process = new CodexProcess(this.config, this.cwd)
    const client = new AppServerClient(process, this.config, (request) =>
      Promise.reject(new Error(`unexpected server request during model discovery: ${request.method}`)),
    )
    try {
      await client.initialize()
      const models: CodexModelInfo[] = []
      const cursors = new Set<string>()
      let cursor: string | null | undefined
      while (cursor !== null) {
        const page = await client.listModels(cursor ?? undefined)
        models.push(...page.data)
        if (page.nextCursor !== null && cursors.has(page.nextCursor)) {
          throw new CodexAppServerError('PROTOCOL_INVALID', 'model/list returned a repeated cursor')
        }
        if (page.nextCursor !== null) cursors.add(page.nextCursor)
        cursor = page.nextCursor
      }
      return Object.freeze(models.filter((model) => !model.hidden))
    } finally {
      client.close()
      await process.dispose()
    }
  }
}

/** Catalog-only DSH adapter; conversation traffic remains owned by CodexAgent. */
export class CodexModelAdapter extends LlmAdapter {
  private announced = false

  constructor(
    private readonly catalog: CodexModelCatalog,
    private readonly onCatalog?: (models: readonly CodexModelInfo[]) => Promise<void>,
  ) {
    super()
  }

  providerInfo(provider: string) {
    return { id: provider, name: 'Codex' }
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.models()
    return models.map((model) => this.toModelInfo(provider, model))
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const discovered = (await this.models()).find((candidate) => candidate.model === model)
    if (discovered === undefined) return { provider, id: model, name: model }
    return {
      ...this.toModelInfo(provider, discovered),
      reasoning: {
        efforts: discovered.supportedReasoningEfforts.map((effort) => ({
          id: ReasoningEffortId(effort.reasoningEffort),
          name: effort.reasoningEffort,
          description: effort.description,
        })),
        ...(discovered.defaultReasoningEffort === undefined
          ? {}
          : { defaultEffort: ReasoningEffortId(discovered.defaultReasoningEffort) }),
      },
    }
  }

  stream(): AsyncIterable<StreamChunk> {
    const error = new CodexAppServerError(
      'PROTOCOL_INVALID',
      'Codex model routing is owned by the Codex AgentFactory, not the DSH LLM stream adapter',
    )
    return {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
    }
  }

  private toModelInfo(provider: string, model: CodexModelInfo): LlmModelInfo {
    return {
      provider,
      id: model.model,
      name: model.displayName,
      description: model.description,
      inputModalities: model.inputModalities,
    }
  }

  private async models(): Promise<readonly CodexModelInfo[]> {
    const models = await this.catalog.list()
    if (!this.announced && this.onCatalog !== undefined) {
      await this.onCatalog(models)
      this.announced = true
    }
    return models
  }
}
