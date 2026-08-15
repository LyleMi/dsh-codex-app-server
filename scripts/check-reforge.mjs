import { execFile } from 'node:child_process'
import { stdout } from 'node:process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const { stdout: reportText } = await execute('reforge', ['analyze', '.', '--output', 'json', '--reproducible'], {
  maxBuffer: 16 * 1024 * 1024,
})
/** @type {unknown} */
const report = JSON.parse(reportText)
const root = asRecord(report)
const issues = Array.isArray(root['issues']) ? root['issues'] : []
if (issues.length > 0) {
  const titles = issues.map((issue) => {
    const title = asRecord(issue)['title']
    return typeof title === 'string' ? title : 'unnamed Reforge issue'
  })
  throw new Error(`Reforge reported ${String(issues.length)} issue(s):\n- ${titles.join('\n- ')}`)
}
stdout.write('Reforge reported 0 enabled structural issues.\n')

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}
