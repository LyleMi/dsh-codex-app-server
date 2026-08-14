import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { buildSpawnSpec } from '../src/process.js'

describe('process argv', () => {
  it('uses direct POSIX argv without a shell', () => {
    expect(buildSpawnSpec(resolveConfig(), '/workspace', 'linux')).toMatchObject({
      command: 'codex',
      args: ['app-server', '--stdio'],
      options: { cwd: '/workspace', detached: true },
    })
  })

  it('uses a fixed cmd.exe tuple for codex.cmd on Windows', () => {
    const spec = buildSpawnSpec(resolveConfig({ command: 'C:\\tools\\codex.cmd' }), 'C:\\workspace', 'win32')
    expect(spec.args).toEqual(['/d', '/s', '/c', '"C:\\tools\\codex.cmd"', 'app-server', '--stdio'])
    expect(spec.options).not.toHaveProperty('shell')
  })

  it('never places prompt text in argv', () => {
    const spec = buildSpawnSpec(resolveConfig(), '/workspace', 'linux')
    expect(JSON.stringify(spec)).not.toContain('user prompt')
  })
})
