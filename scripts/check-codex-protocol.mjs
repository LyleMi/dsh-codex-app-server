import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { stdout } from 'node:process'
import { spawn } from 'node:child_process'

const EXPECTED_CODEX_VERSION = 'codex-cli 0.147.0'
const EXPECTED_GENERATED_HASH = '25c7c8e3b56b2f3210417e9de71fc2a7854359728ada91a7b8d9f07cad47523d'
const EXPECTED_METHOD_HASHES = {
  'ServerRequest.ts': '431303a70ed06354c2b8ad5b0b56d6f00f5eb99940b0da2f8364e261e76dbeae',
  'ServerNotification.ts': 'f02db80a990a66418489cac2ccbb02cf9bc39ed50ffde565797aa2dc075734db',
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {Promise<string>}
 */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`${command} ${args.join(' ')} exited with ${String(code)}`))
    })
  })
}

/**
 * @param {string} source
 * @returns {{ count: number, hash: string }}
 */
function methodHash(source) {
  const methods = [...source.matchAll(/"method": "([^"]+)"/g)]
    .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
    .sort()
  return {
    count: methods.length,
    hash: createHash('sha256').update(JSON.stringify(methods)).digest('hex'),
  }
}

/**
 * @param {string} root
 * @param {string} [directory]
 * @returns {Promise<string[]>}
 */
async function generatedFiles(root, directory = root) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await generatedFiles(root, path)))
    else files.push(path)
  }
  return files
}

/** @param {string} root */
async function generatedContractHash(root) {
  const hash = createHash('sha256')
  for (const file of (await generatedFiles(root)).sort()) {
    hash.update(relative(root, file))
    hash.update('\0')
    hash.update(await readFile(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

const version = await run('codex', ['--version'])
if (version !== EXPECTED_CODEX_VERSION) {
  throw new Error(`expected ${EXPECTED_CODEX_VERSION}, received ${version}`)
}

const output = await mkdtemp(join(tmpdir(), 'codex-app-server-schema-'))
try {
  await run('codex', ['app-server', 'generate-ts', '--out', output])
  const generatedHash = await generatedContractHash(output)
  if (generatedHash !== EXPECTED_GENERATED_HASH) {
    throw new Error(`complete generated protocol contract drifted (hash ${generatedHash})`)
  }
  for (const [file, expectedHash] of Object.entries(EXPECTED_METHOD_HASHES)) {
    const actual = methodHash(await readFile(join(output, file), 'utf8'))
    if (actual.hash !== expectedHash) {
      throw new Error(`${file} method contract drifted (${actual.count} methods, hash ${actual.hash})`)
    }
  }
  stdout.write(`Codex App Server ${EXPECTED_CODEX_VERSION} generated contract matches the reviewed snapshot.\n`)
} finally {
  await rm(output, { recursive: true, force: true })
}
