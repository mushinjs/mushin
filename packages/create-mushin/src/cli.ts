import { relative } from 'node:path'
import { parseArgs } from 'node:util'
import { addAgentFiles, addSkills, createApp, detectPackageManager, install, type PackageManager, VERSION } from './index'

const usage = `Usage: npm create mushin@latest [folder] [-- options]

Creates a Mushin.js app in a new folder (default: my-bot) and installs it.

Options:
  --pm <npm|pnpm>   Package manager to install with (default: the one that ran this)
  --no-install      Only write the files
  --agents <list>   Guides for coding agents, without asking: agents, claude, gemini, copilot,
                    cursor, jetbrains (comma-separated), or none. Default: ask, or agents,claude
  -h, --help        Show this help`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pm: { type: 'string' },
    'no-install': { type: 'boolean' },
    agents: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help) {
  console.log(usage)
  process.exit(0)
}

const pm = (values.pm ?? detectPackageManager()) as PackageManager
if (pm !== 'npm' && pm !== 'pnpm') {
  console.error(`--pm must be npm or pnpm, not ${pm}`)
  process.exit(1)
}

const folder = positionals[0] ?? 'my-bot'
try {
  console.log(`Creating a Mushin.js ${VERSION} app in ${folder}`)
  const { dir } = await createApp(folder, { packageManager: pm })
  if (!values['no-install']) {
    console.log(`Installing with ${pm}…`)
    await install(dir, pm)
    await addSkills(dir)
    await addAgentFiles(dir, values.agents)
  }
  const cd = relative(process.cwd(), dir) || '.'
  const run = pm === 'npm' ? 'npm' : 'pnpm'
  console.log([
    '',
    'Done. Next:',
    ...(cd === '.' ? [] : [`  cd ${cd.includes(' ') ? JSON.stringify(cd) : cd}`]),
    ...(values['no-install'] ? [`  ${run} install`] : []),
    `  ${run} start`,
    '',
    'Open the sign-in link it prints, then follow Quick setup in the dashboard.',
    values['no-install']
      ? `After installing, "${pm === 'npm' ? 'npx' : 'pnpm exec'} mushin agents" writes AGENTS.md and the like, which explain the folder to your coding agent.`
      : 'AGENTS.md (or the file you picked for your coding agent) explains the folder to it.',
  ].join('\n'))
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}
