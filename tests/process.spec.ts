import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { buildSpawnSpec, CodexProcess } from '../src/process.js'

describe('process argv', () => {
  it('uses direct POSIX argv without a shell', () => {
    expect(buildSpawnSpec(resolveConfig({}, 'linux'), '/workspace', 'linux')).toMatchObject({
      command: 'codex',
      args: ['app-server', '--stdio'],
      options: { cwd: '/workspace', detached: true },
    })
  })

  it('uses a fixed cmd.exe tuple for codex.cmd on Windows', () => {
    const spec = buildSpawnSpec(resolveConfig({}, 'win32'), 'C:\\workspace', 'win32')
    expect(spec.command).toBe(process.env['ComSpec'] ?? 'cmd.exe')
    expect(spec.args).toEqual(['/d', '/s', '/c', '"codex.cmd"', 'app-server', '--stdio'])
    expect(spec.options).not.toHaveProperty('shell')
  })

  it('accepts an absolute Windows command override', () => {
    const spec = buildSpawnSpec(resolveConfig({ command: 'C:\\tools\\codex.cmd' }, 'win32'), 'C:\\workspace', 'win32')
    expect(spec.args).toEqual(['/d', '/s', '/c', '"C:\\tools\\codex.cmd"', 'app-server', '--stdio'])
    expect(spec.options).not.toHaveProperty('shell')
  })

  it('never places prompt text in argv', () => {
    const spec = buildSpawnSpec(resolveConfig(), '/workspace', 'linux')
    expect(JSON.stringify(spec)).not.toContain('user prompt')
  })

  it.runIf(process.platform !== 'win32')('settles and disposes after an asynchronous spawn failure', async () => {
    const child = new CodexProcess(resolveConfig({ command: '/definitely/not/a/codex-binary' }), process.cwd())
    const result = await child.exited
    expect(result).toMatchObject({ code: null, signal: null })
    expect(result.error).toBeInstanceOf(Error)
    await expect(child.dispose()).resolves.toBeUndefined()
    expect(child.diagnostic).toContain('ENOENT')
  })
})
