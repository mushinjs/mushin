import { describe, expect, it } from 'vitest'
import { botRef, flowRunRef, logRef, MAX_LOG_LINES, pluginRunRef, refKey, wireRef } from '../src/components/fairy/refs'
import type { FlowRunInfo, PluginRunInfo } from '../src/types'

describe('attachments for Fairy', () => {
  it('sends what the server reads and keeps the tooltip line to itself', () => {
    const item = botRef({ id: 'b1', name: 'Helper' }, 'Online · Cat 123')
    expect(item).toEqual({ kind: 'bot', id: 'b1', label: 'Helper', detail: 'Online · Cat 123' })
    expect(wireRef(item)).toEqual({ kind: 'bot', id: 'b1', label: 'Helper' })
  })

  it('tells a plugin\'s run from a flow run by its bot', () => {
    const flow = flowRunRef({ id: 'r1', flowName: 'Check-in' } as FlowRunInfo)
    const plugin = pluginRunRef({ id: 'r1', botId: 'b1', startedAt: 5 } as PluginRunInfo, 'LLM chat')
    expect(wireRef(flow)).toEqual({ kind: 'run', id: 'r1', label: 'Check-in' })
    expect(wireRef(plugin)).toEqual({ kind: 'run', id: 'r1', bot: 'b1', at: 5, label: 'LLM chat' })
    expect(refKey(flow)).not.toBe(refKey(plugin))
  })

  it('keeps the newest log lines and names the same lines the same', () => {
    const lines = Array.from({ length: MAX_LOG_LINES + 20 }, (_, index) => `line ${index}`)
    const item = logRef(lines, '220 lines', 'bots')
    expect(item.kind === 'log' && item.lines.length).toBe(MAX_LOG_LINES)
    expect(item.kind === 'log' && item.lines[0]).toBe('line 20')
    expect(item.detail).toBe('line 20')
    expect(refKey(logRef(lines, 'again'))).toBe(refKey(item))
    expect(refKey(logRef(lines.slice(1), 'other'))).not.toBe(refKey(logRef(lines.slice(0, -1), 'other')))
  })
})
