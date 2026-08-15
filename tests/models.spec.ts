import { describe, expect, it, vi } from 'vitest'
import { CodexModelAdapter } from '../src/models.js'
import type { CodexModelCatalog } from '../src/models.js'

describe('Codex model adapter', () => {
  it('projects the account catalog and reasoning capabilities into DSH metadata', async () => {
    const catalog = {
      list: () =>
        Promise.resolve([
          {
            id: 'gpt-5.6-sol',
            model: 'gpt-5.6-sol',
            displayName: 'GPT-5.6-Sol',
            description: 'Frontier coding model',
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fast' },
              { reasoningEffort: 'ultra', description: 'Delegated' },
            ],
            defaultReasoningEffort: 'low',
            inputModalities: ['text', 'image'] as const,
            isDefault: true,
          },
        ]),
    } as unknown as CodexModelCatalog
    const onCatalog = vi.fn(() => Promise.resolve())
    const adapter = new CodexModelAdapter(catalog, onCatalog)

    await expect(adapter.listModels('codex-app-server')).resolves.toEqual([
      {
        provider: 'codex-app-server',
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6-Sol',
        description: 'Frontier coding model',
        inputModalities: ['text', 'image'],
      },
    ])
    await expect(adapter.resolveModel('codex-app-server', 'gpt-5.6-sol')).resolves.toMatchObject({
      reasoning: {
        efforts: [{ id: 'low' }, { id: 'ultra' }],
        defaultEffort: 'low',
      },
    })
    expect(onCatalog).toHaveBeenCalledOnce()
  })
})
