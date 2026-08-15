import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CodexAppServerPlugin from '../src/index.js'

let context: Context | undefined
let root: string | undefined

class TestAgentDefaultModel extends Service {
  private selection: ModelSelection = { provider: 'test', model: 'test' }

  constructor(ctx: Context) {
    super(ctx, 'agentDefaultModel')
  }

  currentSelection(): ModelSelection {
    return this.selection
  }

  saveSelection(selection: ModelSelection): Promise<void> {
    this.selection = selection
    return Promise.resolve()
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('bundle composition', () => {
  it('patches the profile into a Codex-only runtime and inserts exactly one Codex factory row', async () => {
    const source = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const patches = yaml.load(source, { schema: entryListSchema })
    if (!Array.isArray(patches)) throw new Error('bundle patch must be a list')
    const result = applyEntryPatches(
      [
        { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop' },
        { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek' },
        { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
        { id: 'session-title-llm', name: '@deepseek-ai/dsh-session-title-first-prompt-llm' },
      ],
      patches,
      vi.fn(),
    )
    expect(result.find((entry) => entry.id === 'agent-loop')).toMatchObject({ disabled: true })
    expect(result.find((entry) => entry.id === 'llm-deepseek')).toMatchObject({ disabled: true })
    expect(result.find((entry) => entry.id === 'llm-pi-ai')).toMatchObject({ disabled: true })
    expect(result.find((entry) => entry.id === 'session-title-llm')).toMatchObject({ disabled: true })
    expect(result.filter((entry) => entry.name === 'dsh-codex-app-server' && !entry.disabled)).toHaveLength(1)
  })

  it('loads the effective composition through the real Cordis Loader', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-codex-loader-'))
    const configUrl = new URL('effective.cordis.yml', pathToFileURL(`${root}/`))
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(
        configUrl,
        [
          "- id: session\n  name: '@deepseek-ai/dsh-session'",
          "- id: agent\n  name: '@deepseek-ai/dsh-agent'",
          "- id: llm\n  name: '@deepseek-ai/dsh-llm'",
          "- id: system-prompt\n  name: '@deepseek-ai/dsh-system-prompt'",
          "- id: tools\n  name: '@deepseek-ai/dsh-tools'",
          "- id: commands\n  name: '@deepseek-ai/dsh-commands'",
          "- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'",
          "- id: agent-loop\n  name: '@deepseek-ai/dsh-agent-loop'\n  disabled: true",
          "- id: llm-deepseek\n  name: '@deepseek-ai/dsh-llm-deepseek'\n  disabled: true",
          "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  disabled: true",
          "- id: session-title-llm\n  name: '@deepseek-ai/dsh-session-title-first-prompt-llm'\n  disabled: true",
          '- id: dsh-codex-app-server\n  name: dsh-codex-app-server',
          '',
        ].join('\n'),
      ),
    )
    const disabledLoop = vi.fn(() => {
      throw new Error('disabled agent-loop mounted')
    })
    context = new Context()
    context.baseUrl = pathToFileURL(`${root}/`).href
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@deepseek-ai/dsh-agent-default-model', TestAgentDefaultModel],
      ['@deepseek-ai/dsh-agent-loop', disabledLoop],
      ['dsh-codex-app-server', CodexAppServerPlugin],
    ])
    context.loader.internal = {
      version: 'v2',
      import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return Promise.resolve(modules.get(specifier))
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: configUrl.href } })
    await context.loader.await()
    expect(disabledLoop).not.toHaveBeenCalled()
    expect(context.codexAppServer.factory).toBeDefined()
    expect((await context.systemPrompt.assemble()).variables).toHaveProperty('cwd', undefined)
  })
})
