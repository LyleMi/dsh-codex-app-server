import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env, execPath, stdout } from 'node:process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const pnpmCli = env['npm_execpath']
if (pnpmCli === undefined || !pnpmCli.toLowerCase().includes('pnpm')) {
  throw new Error('pack:check must run through pnpm')
}

const destination = await mkdtemp(join(tmpdir(), 'dsh-codex-pack-'))
try {
  const { stdout: output } = await execute(execPath, [pnpmCli, 'pack', '--pack-destination', destination], {
    cwd: new URL('..', import.meta.url),
    maxBuffer: 4 * 1024 * 1024,
  })
  stdout.write(output)
} finally {
  await rm(destination, { recursive: true, force: true })
}
