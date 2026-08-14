import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CodexAppServerPlugin from '../src/index.js'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('bundle composition', () => {
  it('patches out agent-loop and inserts exactly one Codex factory row', async () => {
    const source = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const patches = yaml.load(source, { schema: entryListSchema })
    if (!Array.isArray(patches)) throw new Error('bundle patch must be a list')
    const result = applyEntryPatches([{ id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop' }], patches, vi.fn())
    expect(result.find((entry) => entry.id === 'agent-loop')).toMatchObject({ disabled: true })
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
          "- id: agent-loop\n  name: '@deepseek-ai/dsh-agent-loop'\n  disabled: true",
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
  })
})
