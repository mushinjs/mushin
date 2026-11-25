import { describe, expect, it } from 'vitest'
import { type Fold, foldedCount, foldKey, foldLines } from '../src/log-fold'

const info = (text: string, name = 'bot') => ({ type: 'info', name, text })
const warn = (text: string, name = 'bot') => ({ type: 'warn', name, text })

/** The three lines a bot logs on each attempt to reach a OneBot server that is down. */
function attempt(delay: number, port = 6700) {
  return [
    info(`connecting to ws://127.0.0.1:${port} with a token`),
    warn(`cannot reach ws://127.0.0.1:${port}: connect ECONNREFUSED 127.0.0.1:${port}`),
    info(`reconnecting in ${delay}s`),
  ]
}

const shape = (folds: Fold[]) => folds.map(({ period, count }) => `${period}x${count}`)

describe('foldKey', () => {
  it('ignores numbers but not level, source or words', () => {
    expect(foldKey(info('reconnecting in 1s'))).toBe(foldKey(info('reconnecting in 30s')))
    expect(foldKey(info('reconnecting in 1s'))).not.toBe(foldKey(warn('reconnecting in 1s')))
    expect(foldKey(info('reconnecting in 1s'))).not.toBe(foldKey(info('reconnecting in 1s', 'flow')))
    expect(foldKey(info('reconnecting in 1s'))).not.toBe(foldKey(info('retrying in 1s')))
  })
})

describe('foldLines', () => {
  it('folds one line repeating', () => {
    const folds = foldLines([info('a'), info('tick 1'), info('tick 2'), info('tick 3'), info('b')])
    expect(shape(folds)).toEqual(['1x1', '1x3', '1x1'])
    expect(folds[1]!.start).toBe(1)
    expect(foldedCount(folds)).toBe(2)
  })

  it('folds a reconnect cycle of three lines, backoff delays included', () => {
    const lines = [info('bot starting'), ...[1, 2, 4, 8, 16].flatMap((delay) => attempt(delay))]
    for (let i = 0; i < 1514; i++) lines.push(...attempt(30))
    expect(lines.length).toBe(4558)
    const folds = foldLines(lines)
    expect(shape(folds)).toEqual(['1x1', '3x1519'])
    // The intro line and one block of three.
    expect(lines.length - foldedCount(folds)).toBe(4)
    // The attempt under way stays outside the fold until it is complete.
    lines.push(info('connecting to ws://127.0.0.1:6700 with a token'))
    expect(shape(foldLines(lines))).toEqual(['1x1', '3x1519', '1x1'])
  })

  it('folds the cycle down to one line once a filter leaves only its warnings', () => {
    const lines = Array.from({ length: 200 }, (_, i) => attempt(30, 6700 + (i % 3))).flat().filter((line) => line.type === 'warn')
    expect(shape(foldLines(lines))).toEqual(['1x200'])
  })

  it('ends a fold at any other line', () => {
    const lines = [...attempt(30), ...attempt(30), warn('something else'), ...attempt(30), ...attempt(30)]
    expect(shape(foldLines(lines))).toEqual(['3x2', '1x1', '3x2'])
  })

  it('does not fold a block that occurs once, nor blocks longer than five lines', () => {
    expect(shape(foldLines([info('a'), info('b'), info('c')]))).toEqual(['1x1', '1x1', '1x1'])
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((text) => info(text))
    expect(foldLines([...six, ...six]).every((fold) => fold.count === 1)).toBe(true)
    expect(shape(foldLines([...six, ...six], { maxPeriod: 6 }))).toEqual(['6x2'])
  })

  it('takes the block that covers most lines, then the shortest', () => {
    const [a, b] = [info('a'), info('b')]
    expect(shape(foldLines([a, a, a, a]))).toEqual(['1x4'])
    expect(shape(foldLines([a, a, b, a, a, b]))).toEqual(['3x2'])
    expect(shape(foldLines([a, b, a, b, a]))).toEqual(['2x2', '1x1'])
  })

  it('keeps where a fold starts as lines arrive, so the dashboard can key it by its first line', () => {
    const lines = [info('intro'), ...attempt(1)]
    const starts = new Set<number>()
    for (let i = 0; i < 20; i++) {
      lines.push(...attempt(30))
      for (let cut = lines.length - 2; cut <= lines.length; cut++) starts.add(foldLines(lines.slice(0, cut))[1]!.start)
    }
    expect([...starts]).toEqual([1])
  })

  it('handles no lines', () => {
    expect(foldLines([])).toEqual([])
  })
})
