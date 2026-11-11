import { seg } from '@mushinjs/core'
import { describe, expect, it } from 'vitest'
import { type CommandArg, commandUsage, formatArgs, helpText, parseArgs, usageReply } from '../src/commands'

describe('command arguments', () => {
  it('converts numbers, yes or no, choices and defaults', () => {
    const args: CommandArg[] = [
      { name: 'n', type: 'number' },
      { name: 'loud', type: 'boolean', optional: true },
      { name: 'mode', type: 'choice', choices: ['fast', 'slow'], default: 'slow' },
    ]
    expect(parseArgs(args, '3 是 FAST')).toEqual({ ok: true, values: { n: 3, loud: true, mode: 'fast' } })
    expect(parseArgs(args, '3')).toEqual({ ok: true, values: { n: 3, mode: 'slow' } })
    expect(parseArgs(args, 'x')).toMatchObject({ ok: false, arg: 'n' })
    expect(parseArgs(args, '3 maybe')).toMatchObject({ ok: false, arg: 'loud' })
    expect(parseArgs(args, '3 否 medium')).toMatchObject({ ok: false, arg: 'mode' })
  })

  it('reads an @mention as the user id, or a written id', () => {
    const args: CommandArg[] = [{ name: 'who', type: 'user' }, { name: 'note', type: 'text', optional: true }]
    const segments = [seg.text('/ban '), seg.at('123456', 'Bob'), seg.text(' spam')]
    expect(parseArgs(args, '@Bob spam', segments)).toEqual({ ok: true, values: { who: '123456', note: 'spam' } })
    expect(parseArgs(args, '@654321')).toEqual({ ok: true, values: { who: '654321' } })
    expect(parseArgs(args, 'Bob')).toMatchObject({ ok: false, arg: 'who' })
  })

  it('gives the last text argument the rest, leaving a word for each later one', () => {
    expect(parseArgs([{ name: 'a', type: 'text' }, { name: 'b', type: 'text' }], 'x y z')).toEqual({ ok: true, values: { a: 'x', b: 'y z' } })
    expect(parseArgs([{ name: 'a', type: 'text', rest: true }, { name: 'n', type: 'number' }], 'x y 3')).toEqual({ ok: true, values: { a: 'x y', n: 3 } })
  })

  it('writes usage lines with the command\'s own prefix and argument notes', () => {
    const def = { name: '签到', prefixes: ['#'], args: [{ name: '分数', type: 'number', description: '0 到 100' }, { name: '备注', type: 'text', optional: true }] as CommandArg[] }
    expect(formatArgs(def.args)).toBe('<分数:数字> [备注]')
    expect(commandUsage(def)).toBe('#签到 <分数:数字> [备注]')
    expect(usageReply(def)).toBe('用法：#签到 <分数:数字> [备注]\n分数：0 到 100')
    expect(helpText([{ ...def, botId: 'b', source: { kind: 'flow', id: 'f', name: 'f' } }], { prefixes: ['/'] })).toContain('#签到 <分数:数字> [备注]')
  })
})
