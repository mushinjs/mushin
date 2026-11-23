import { emitKeypressEvents } from 'node:readline'
import { styleText } from 'node:util'

export interface Choice {
  value: string
  label: string
  hint?: string
}

export interface PromptStreams {
  input: NodeJS.ReadableStream & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown }
  output: NodeJS.WritableStream
}

/**
 * Asks in the terminal for any number of choices: ↑/↓ move, Space ticks, `a` ticks all, Enter confirms.
 * Resolves to the ticked values in list order, or `undefined` when the user pressed Ctrl+C or Esc.
 */
export function multiSelect(question: string, choices: Choice[], initial: readonly string[] = [], streams: PromptStreams = { input: process.stdin, output: process.stdout }) {
  const { input, output } = streams
  const picked = new Set(initial)
  let cursor = 0
  let lines = 0

  const render = (done = false) => {
    if (lines) output.write(`\x1b[${lines}A\x1b[0J`)
    const rows = [`${styleText(done ? 'green' : 'cyan', done ? '✔' : '›')} ${styleText('bold', question)}`]
    if (done) {
      const names = choices.filter((choice) => picked.has(choice.value)).map((choice) => choice.label)
      rows.push(`  ${styleText('dim', names.length ? names.join(', ') : 'none')}`)
    } else {
      choices.forEach((choice, index) => {
        const here = index === cursor
        const box = picked.has(choice.value) ? '■' : '□'
        const label = `${box} ${choice.label}`
        const hint = choice.hint ? styleText('dim', ` (${choice.hint})`) : ''
        rows.push(`${here ? styleText('cyan', '›') : ' '} ${here ? styleText('cyan', label) : label}${hint}`)
      })
      rows.push(styleText('dim', '  ↑/↓ navigate · Space select · a all · Enter confirm'))
    }
    output.write(rows.join('\n') + '\n')
    lines = done ? 0 : rows.length
  }

  return new Promise<string[] | undefined>((done) => {
    emitKeypressEvents(input)
    const raw = Boolean(input.isTTY && !input.isRaw && input.setRawMode)
    if (raw) input.setRawMode!(true)
    input.resume()
    const finish = (result: string[] | undefined) => {
      input.off('keypress', onKey)
      if (raw) input.setRawMode!(false)
      input.pause()
      if (result) render(true)
      done(result)
    }
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean } = {}) => {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') return finish(undefined)
      if (key.name === 'return' || key.name === 'enter') return finish(choices.filter((choice) => picked.has(choice.value)).map((choice) => choice.value))
      if (key.name === 'up' || key.name === 'k') cursor = (cursor + choices.length - 1) % choices.length
      else if (key.name === 'down' || key.name === 'j' || key.name === 'tab') cursor = (cursor + 1) % choices.length
      else if (key.name === 'space' || text === ' ') {
        const value = choices[cursor]!.value
        if (picked.has(value)) picked.delete(value)
        else picked.add(value)
      } else if (text === 'a') {
        const all = choices.every((choice) => picked.has(choice.value))
        for (const choice of choices) all ? picked.delete(choice.value) : picked.add(choice.value)
      } else return
      render()
    }
    input.on('keypress', onKey)
    render()
  })
}
