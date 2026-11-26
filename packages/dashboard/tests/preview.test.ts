import { beforeEach, describe, expect, it, vi } from 'vitest'

const call = vi.fn()
vi.mock('../src/api', () => ({ call: (...args: unknown[]) => call(...args) }))

const { cachedPreview, forgetPreviews, FRESH_FOR, KEEP, loadPreview } = await import('../src/components/fairy/preview')

const preview = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, running: false, updatedAt: 1, total: 0, messages: [], steps: [], ...extra })

describe('conversation previews', () => {
  beforeEach(() => {
    forgetPreviews()
    call.mockReset()
    call.mockImplementation(async (_name: string, input: { id: string }) => preview(input.id))
    vi.useRealTimers()
  })

  it('does not ask again for a resting conversation looked at a moment ago', async () => {
    vi.useFakeTimers()
    await loadPreview('a')
    await loadPreview('a')
    expect(call).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(FRESH_FOR)
    await loadPreview('a')
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('asks again for one at work, one that changed since, or when told to', async () => {
    call.mockImplementationOnce(async () => preview('a', { running: true }))
    await loadPreview('a')
    await loadPreview('a')
    expect(call).toHaveBeenCalledTimes(2)
    await loadPreview('a', { updatedAt: 1 })
    expect(call).toHaveBeenCalledTimes(2)
    await loadPreview('a', { updatedAt: 2 })
    expect(call).toHaveBeenCalledTimes(3)
    await loadPreview('a', { fresh: true })
    expect(call).toHaveBeenCalledTimes(4)
  })

  it('shares one request between cards that open together', async () => {
    await Promise.all([loadPreview('a'), loadPreview('a')])
    expect(call).toHaveBeenCalledTimes(1)
  })

  it(`keeps the last ${KEEP} conversations looked at`, async () => {
    for (let index = 0; index < KEEP; index++) await loadPreview(`s${index}`)
    // Looking at the first again keeps it; the second is now the longest unseen.
    await loadPreview('s0')
    await loadPreview('extra')
    expect(call).toHaveBeenCalledTimes(KEEP + 1)
    expect(cachedPreview('s0')).toBeDefined()
    expect(cachedPreview('s1')).toBeUndefined()
    expect(cachedPreview('s2')).toBeDefined()
    expect(cachedPreview('extra')).toBeDefined()
  })
})
