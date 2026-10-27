import type {} from '@mushin/plugin-flows'
import { start } from './start'

export interface TestCommandOptions {
  baseDir: string
  /** Only this flow, by id or name. */
  flow?: string
  /** Print one JSON summary instead of lines. */
  json?: boolean
  print?: (line: string) => void
}

const SETTLED = new Set(['active', 'failed', 'missing', 'disabled'])

/**
 * `mushin test`: boots the instance offline, runs the saved test cases of every flow that has
 * some and prints the results. Returns the exit code: 1 when a case failed, 0 otherwise.
 */
export async function testCommand(options: TestCommandOptions) {
  const print = options.print ?? ((line: string) => console.log(line))
  const instance = await start({ baseDir: options.baseDir, quiet: true, offline: true })
  const { ctx } = instance
  try {
    const deadline = Date.now() + 20_000
    while (!ctx.manager.entries.every((entry) => SETTLED.has(ctx.manager.status(entry.id).status)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const flows = ctx.get('flows')
    if (!flows) {
      print('The flows plugin is not running in this instance.')
      return 1
    }
    const chosen = flows.list().filter((flow) => !options.flow || flow.id === options.flow || flow.name === options.flow)
    if (options.flow && !chosen.length) {
      print(`No flow with id or name "${options.flow}".`)
      return 1
    }
    const summaries = []
    for (const flow of chosen) {
      if (!(await flows.tests(flow.id)).cases.length) continue
      const run = await flows.runTests(flow.id, { source: 'cli' })
      summaries.push({ flow: flow.id, name: flow.name, passed: run.passed, failed: run.failed, uncovered: run.uncovered, results: run.results.map(({ trace: _trace, ...rest }) => rest) })
      if (options.json) continue
      print(`${run.failed ? '✗' : '✓'} ${flow.name} (${flow.id}): ${run.passed}/${run.passed + run.failed} passed${run.uncovered.length ? `, ${run.uncovered.length} node(s) not covered` : ''}`)
      for (const result of run.results.filter((item) => !item.passed)) {
        print(`    ✗ ${result.name}`)
        for (const failure of result.failures) print(`        ${failure.message}`)
      }
    }
    const failed = summaries.reduce((sum, item) => sum + item.failed, 0)
    const passed = summaries.reduce((sum, item) => sum + item.passed, 0)
    if (options.json) print(JSON.stringify({ passed, failed, flows: summaries }, null, 2))
    else if (!summaries.length) print('No flow has test cases yet. Add some in the flow editor\'s Tests tab.')
    else print(`\n${passed} passed, ${failed} failed in ${summaries.length} flow(s)`)
    return failed ? 1 : 0
  } finally {
    await instance.stop()
  }
}
