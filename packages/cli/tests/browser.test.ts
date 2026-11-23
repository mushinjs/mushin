import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeUrl } from '@mushinjs/plugin-browser'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

const PAGE = `<!doctype html><title>Greeter</title>
<h1>Greeter</h1>
<label>Name <input id="name"></label>
<button onclick="document.getElementById('out').textContent = 'Hello, ' + document.getElementById('name').value">Greet</button>
<p id="out">Nobody yet</p>
<a href="/second">Second page</a>`

/** Whether a browser starts here: Chrome, Edge or Playwright's Chromium. Without one the browser tests skip. */
async function findBrowser() {
  const { chromium } = createRequire(new URL('../../plugin-browser/package.json', import.meta.url))('playwright-core') as { chromium: { launch(options: object): Promise<{ close(): Promise<void> }> } }
  for (const channel of ['chrome', 'msedge', 'chromium']) {
    try {
      const browser = await chromium.launch({ channel, headless: true })
      await browser.close()
      return true
    } catch {}
  }
  return false
}

const hasBrowser = await findBrowser()
let app: TestInstance
let server: Server
let site: string

beforeAll(async () => {
  if (!hasBrowser) return
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(request.url === '/second' ? '<title>Second</title><h1>The second page</h1>' : PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  app = await startInstance()
  await app.call('plugins.enable', { package: '@mushinjs/plugin-browser' })
  await app.call('plugins.configure', { id: 'browser', config: { headless: true, keepSignIns: false } })
  await waitFor(() => app.ctx.actions.has('browser.open'))
})

afterAll(async () => {
  await app?.stop()
  server?.close()
})

describe('browser addresses', () => {
  it('turns what people type into addresses', () => {
    expect(normalizeUrl('example.com/a')).toBe('https://example.com/a')
    expect(normalizeUrl('localhost:5160/plugins')).toBe('http://localhost:5160/plugins')
    expect(normalizeUrl(' http://x.test ')).toBe('http://x.test')
  })
})

describe.skipIf(!hasBrowser)('the browser plugin', () => {
  it('opens a page, types and clicks by ref, and shows each step to the dashboard', async () => {
    const dashboard = await app.connect()
    const opened = await app.call('browser.open', { url: site })
    expect(opened).toMatchObject({ tab: expect.any(String), url: `${site}/`, title: 'Greeter' })
    expect(opened.snapshot).toContain('heading "Greeter"')
    const field = opened.snapshot.match(/textbox "Name" \[ref=(e\d+)\]/)?.[1]
    const button = opened.snapshot.match(/button "Greet" \[ref=(e\d+)\]/)?.[1]
    expect(field && button).toBeTruthy()

    const typed = await app.call('browser.type', { ref: field, text: 'Fairy' })
    const again = typed.snapshot.match(/button "Greet" \[ref=(e\d+)\]/)?.[1]
    const clicked = await app.call('browser.click', { ref: again })
    expect(clicked.snapshot).toContain('Hello, Fairy')
    expect(await app.call('browser.snapshot', { find: 'second' })).toMatchObject({ snapshot: expect.stringMatching(/^- link "Second page" \[ref=e\d+\]/) })

    const frame = await waitFor(() => dashboard.events.findLast((event) => event.name === 'browser/frame')?.data)
    expect(frame).toMatchObject({ url: `${site}/`, width: 1280, height: 800, tabs: [{ active: true, title: 'Greeter' }] })
    expect(frame.image).toMatch(/^data:image\/jpeg;base64,/)
    dashboard.close()
  })

  it('works with tabs, screenshots and the dashboard\'s own clicks', async () => {
    const second = await app.call('browser.open', { url: `${site}/second`, newTab: true })
    expect(second).toMatchObject({ title: 'Second' })
    const { tabs } = await app.call('browser.tabs')
    expect(tabs).toHaveLength(2)
    expect(tabs.find((tab: any) => tab.active).id).toBe(second.tab)

    const shot = await app.call('browser.screenshot', {})
    expect(existsSync(shot.path)).toBe(true)

    await app.call('browser.tab', { id: second.tab, close: true })
    expect((await app.call('browser.tabs')).tabs).toHaveLength(1)
    // The picture in the workspace is clickable: a click on the link's spot follows it.
    const frame = await app.call('browser.frame')
    expect(frame.title).toBe('Greeter')
    const box = await app.call('browser.evaluate', { script: "const r = document.querySelector('a').getBoundingClientRect(); return { x: r.x + 5, y: r.y + 5 }" })
    expect(await app.call('browser.mouse', box.result)).toMatchObject({ title: 'Second' })
  })

  it('names a stale ref plainly, and asks before clicking when set to', async () => {
    await expect(app.call('browser.click', { ref: 'e999' })).rejects.toThrow(/browser\.snapshot/)
    expect(app.ctx.actions.approval('browser.click', { ref: 'e1' })).toBeUndefined()
    await app.call('plugins.configure', { id: 'browser', config: { headless: true, keepSignIns: false, fairyActs: 'ask' } })
    await waitFor(() => app.ctx.actions.has('browser.click'))
    expect(app.ctx.actions.approval('browser.click', { ref: 'e1' })).toBe('confirm')
    expect(app.ctx.actions.approval('browser.open', { url: site })).toBeUndefined()
  })

  it('closes the browser and says so', async () => {
    await app.call('browser.open', { url: site })
    const dashboard = await app.connect()
    expect(await app.call('browser.close')).toEqual({ closed: true })
    await waitFor(() => dashboard.events.some((event) => event.name === 'browser/closed'))
    expect(await app.call('browser.tabs')).toMatchObject({ running: false, tabs: [] })
    expect(await app.call('browser.frame')).toBeNull()
    dashboard.close()
  })
})
