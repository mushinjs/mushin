import { relative } from 'node:path'
import { parseArgs } from 'node:util'
import { createApp, detectPackageManager, install, type PackageManager, VERSION } from './index'

const usage = `Usage: npm create mushin@latest [folder] [-- options]

Creates a Mushin.js app in a new folder (default: my-bot) and installs it.

Options:
  --pm <npm|pnpm>   Package manager to install with (default: the one that ran this)
  --no-install      Only write the files
  -h, --help        Show this help`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pm: { type: 'string' },
    'no-install': { type: 'boolean' },
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
    'AGENTS.md explains the folder to you and to your AI.',
  ].join('\n'))
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}
