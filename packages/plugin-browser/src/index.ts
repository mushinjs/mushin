import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Context, field, MushinError, z } from '@mushinjs/core'
import type {} from '@mushinjs/plugin-storage'
import type { BrowserContext, Page } from 'playwright-core'

export const name = 'browser'
export const inject = ['actions', 'storage']

/** A tab, as lists show it. */
export interface BrowserTab {
  id: string
  url: string
  title: string
  active: boolean
}

/** What the page looks like now, for the Fairy workspace: a JPEG of the visible part and the tabs. */
export interface BrowserFrame {
  tab: string
  url: string
  title: string
  /** `data:image/jpeg;base64,...` of the viewport. */
  image: string
  /** The viewport in CSS pixels; a click on the image maps to these. */
  width: number
  height: number
  tabs: BrowserTab[]
  at: number
}

declare module '@mushinjs/core' {
  interface Events {
    /** The page changed: after each action, and when asked for. */
    'browser/frame'(frame: BrowserFrame): void
    /** The browser closed, by the plugin or by the user closing its window. */
    'browser/closed'(): void
  }
}

const zh = (title: string, description: string, options?: Record<string, string>) => ({ 'zh-CN': { title, description, ...(options ? { options } : {}) } })

export const Config = z.object({
  browser: z.enum(['auto', 'chrome', 'msedge', 'chromium']).default('auto').meta(field('Browser', 'Which installed browser to use; auto tries Chrome, then Edge, then Chromium', {
    ...zh('浏览器', '使用本机安装的哪个浏览器；自动时依次尝试 Chrome、Edge、Chromium', { auto: '自动', chrome: 'Chrome', msedge: 'Edge', chromium: 'Chromium' }),
  }, { options: { auto: 'Auto', chrome: 'Chrome', msedge: 'Edge', chromium: 'Chromium' } })),
  executablePath: z.string().default('').meta(field('Browser program', 'Path to a Chrome, Edge or Chromium program, when it is not installed where it usually is', {
    ...zh('浏览器程序', '浏览器没有装在常见位置时，填写 Chrome、Edge 或 Chromium 程序的路径'),
  })),
  headless: z.boolean().default(false).meta(field('Hide the window', 'Run the browser without a window, as on a server; the Fairy workspace still shows the page. On Linux without a display it always runs this way', {
    ...zh('隐藏窗口', '不显示浏览器窗口（适合服务器），Fairy 工作区里仍然能看到页面。没有图形界面的 Linux 上总是这样运行'),
  })),
  keepSignIns: z.boolean().default(true).meta(field('Keep sign-ins', 'Keep cookies and sign-ins between starts, in a browser profile of its own under data/plugins/browser/profile (never your usual profile)', {
    ...zh('保留登录状态', '在 data/plugins/browser/profile 下用单独的浏览器配置保存 Cookie 和登录状态（不会使用你平时的浏览器配置）'),
  })),
  fairyActs: z.enum(['auto', 'ask']).default('auto').meta(field('Fairy clicks and types', 'Whether Fairy asks before each click, typing or key press; opening and reading pages never asks', {
    ...zh('Fairy 点击和输入', 'Fairy 每次点击、输入或按键前是否先问你；打开和读取网页从不询问', { auto: '直接执行', ask: '先问我' }),
  }, { options: { auto: 'Without asking', ask: 'Ask first' } })),
})

export type Config = z.output<typeof Config>

/** Most characters of a page outline Fairy gets back; `find` narrows a longer one. */
const SNAPSHOT_LIMIT = 15_000
const VIEWPORT = { width: 1280, height: 800 }

/** One browser for the whole instance, started on first use; its tabs are Fairy's and the user's alike. */
export class BrowserSession {
  private context?: BrowserContext
  private launching?: Promise<BrowserContext>
  private ids = new WeakMap<Page, string>()
  private seq = 0
  private current?: Page
  /** Which browser runs, for messages. */
  program?: string

  constructor(private ctx: Context, private config: Config) {}

  get running() {
    return !!this.context
  }

  private async launch(): Promise<BrowserContext> {
    const { chromium } = await import('playwright-core')
    const headless = this.config.headless || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
    const options = { headless, viewport: VIEWPORT, args: ['--no-first-run', '--no-default-browser-check'] }
    const profile = this.config.keepSignIns ? this.ctx.storage.path('browser/profile') : undefined
    if (profile) await mkdir(profile, { recursive: true })
    const attempts: { label: string; options: Record<string, unknown> }[] = this.config.executablePath
      ? [{ label: this.config.executablePath, options: { executablePath: this.config.executablePath } }]
      : (this.config.browser === 'auto' ? ['chrome', 'msedge', 'chromium'] : [this.config.browser]).map((channel) => ({ label: channel, options: { channel } }))
    const errors: string[] = []
    for (const attempt of attempts) {
      try {
        const context = profile
          ? await chromium.launchPersistentContext(profile, { ...options, ...attempt.options })
          : await (await chromium.launch({ ...options, ...attempt.options })).newContext({ viewport: VIEWPORT })
        this.program = attempt.label
        this.ctx.logger('browser').info('started %s%s', attempt.label, headless ? ' without a window' : '')
        return context
      } catch (error) {
        errors.push(`${attempt.label}: ${String((error as Error).message).split('\n')[0]}`)
      }
    }
    throw new MushinError('unavailable', `No browser could start (${errors.join('; ')}). Install Chrome or Edge, or set the browser program in the Browser plugin settings`)
  }

  /** The browser, started if needed. */
  async open() {
    if (this.context) return this.context
    this.launching ??= this.launch().then((context) => {
      this.context = context
      context.on('page', (page) => {
        this.track(page)
        this.current = page
      })
      context.on('close', () => {
        this.context = undefined
        this.current = undefined
        this.ctx.emit('browser/closed')
      })
      for (const page of context.pages()) this.track(page)
      return context
    }).finally(() => (this.launching = undefined))
    return this.launching
  }

  private track(page: Page) {
    if (this.ids.has(page)) return
    this.ids.set(page, `t${++this.seq}`)
    page.on('close', () => {
      if (this.current === page) this.current = this.context?.pages().at(-1)
    })
  }

  idOf(page: Page) {
    return this.ids.get(page)!
  }

  pages() {
    return this.context?.pages().filter((page) => !page.isClosed()) ?? []
  }

  async tabs(): Promise<BrowserTab[]> {
    return Promise.all(this.pages().map(async (page) => ({
      id: this.idOf(page),
      url: page.url(),
      title: await page.title().catch(() => ''),
      active: page === this.current,
    })))
  }

  /** A tab by id, or the current one; a new one when there is none. */
  async page(tab?: string) {
    const context = await this.open()
    if (tab) {
      const page = this.pages().find((item) => this.idOf(item) === tab)
      if (!page) throw new MushinError('not_found', `No tab ${tab}; browser.tabs lists them`)
      this.current = page
      return page
    }
    if (this.current && !this.current.isClosed()) return this.current
    this.current = this.pages().at(-1) ?? await context.newPage()
    this.track(this.current)
    return this.current
  }

  async newPage() {
    const context = await this.open()
    const page = await context.newPage()
    this.track(page)
    this.current = page
    return page
  }

  /** Lets a click or key press start its navigation, then waits a moment for the page to settle. */
  async settle(page: Page) {
    await page.waitForTimeout(250)
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {})
  }

  /** The page as an outline with refs (`[ref=e12]`) that click and type take. */
  async snapshot(page: Page, find?: string) {
    let text = await page.ariaSnapshot({ mode: 'ai', timeout: 10_000 }).catch((error) => `(The page could not be read: ${(error as Error).message.split('\n')[0]})`)
    if (find) {
      const needle = find.toLowerCase()
      const lines = text.split('\n').filter((line) => line.toLowerCase().includes(needle)).map((line) => line.trim())
      text = lines.length ? lines.join('\n') : `(Nothing on the page matches "${find}".)`
    }
    if (text.length > SNAPSHOT_LIMIT) {
      text = `${text.slice(0, SNAPSHOT_LIMIT)}\n(… cut at ${SNAPSHOT_LIMIT} of ${text.length} characters; pass find to see the lines that mention a word.)`
    }
    return text
  }

  /** What an action returns: the tab and the page outline. Also shows the page in the workspace. */
  async result(page: Page, options: { find?: string; snapshot?: boolean } = {}) {
    void this.show(page)
    return {
      tab: this.idOf(page),
      url: page.url(),
      title: await page.title().catch(() => ''),
      ...(options.snapshot === false ? {} : { snapshot: await this.snapshot(page, options.find) }),
    }
  }

  /** Sends what the page looks like now to the dashboard. */
  async show(page?: Page) {
    page ??= this.current
    if (!page || page.isClosed()) return
    const frame = await this.frame(page).catch(() => undefined)
    if (frame) this.ctx.emit('browser/frame', frame)
    return frame
  }

  async frame(page: Page): Promise<BrowserFrame> {
    const image = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 })
    const size = page.viewportSize() ?? VIEWPORT
    return {
      tab: this.idOf(page),
      url: page.url(),
      title: await page.title().catch(() => ''),
      image: `data:image/jpeg;base64,${image.toString('base64')}`,
      width: size.width,
      height: size.height,
      tabs: await this.tabs(),
      at: Date.now(),
    }
  }

  async close() {
    await this.launching?.catch(() => {})
    const context = this.context
    this.context = undefined
    this.current = undefined
    // A browser started for a temporary profile outlives its context unless closed too.
    const browser = context?.browser()
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
  }
}

/** A URL from what someone typed: `example.com` becomes `https://example.com`. */
export function normalizeUrl(input: string) {
  const text = input.trim()
  if (/^(https?|file|data|about|chrome):/i.test(text)) return text
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`
  return `https://${text}`
}

export function apply(ctx: Context, raw: z.input<typeof Config>) {
  const config = Config.parse(raw ?? {})
  const session = new BrowserSession(ctx, config)
  ctx.effect(() => () => void session.close(), 'browser.session')

  const tab = z.string().optional().describe('Tab id from browser.tabs; the current tab when left out')
  const ref = z.string().min(1).describe('An element ref from the page outline, such as e12')
  /** Clicks and typing ask first when the setting says so; otherwise the action's risk decides. */
  const acts = () => (config.fairyActs === 'ask' ? 'confirm' as const : undefined)
  const locate = (page: Page, value: string) => page.getByRef(value.replace(/^\[?ref=|\]$/g, ''))
  /** Turns Playwright's long messages into one line Fairy can act on. */
  const attempt = async <T>(work: () => Promise<T>) => {
    try {
      return await work()
    } catch (error) {
      if (error instanceof MushinError) throw error
      const message = String((error as Error).message).split('\n')[0]!.replace(/^\w+\.\w+: /, '')
      throw new MushinError('invalid_input', `${message}. Read the page again (browser.snapshot) for current refs`)
    }
  }

  ctx.actions.define({
    name: 'browser.open',
    description: 'Open a web page in the browser on this machine (Chrome, Edge or Chromium, started on first use) and return the page as an outline: headings, text, links, buttons and fields, each element with a ref such as [ref=e12] that browser.click and browser.type take. The user sees the page in the Fairy workspace.',
    risk: 'read',
    input: z.object({
      url: z.string().min(1).describe('Address, e.g. https://example.com; a bare domain gets https://'),
      newTab: z.boolean().default(false).describe('Open in a new tab instead of the current one'),
      find: z.string().optional().describe('Return only the lines of the outline that mention this text'),
    }),
    handler: ({ url, newTab, find }) => attempt(async () => {
      const page = newTab ? await session.newPage() : await session.page()
      await page.goto(normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await session.settle(page)
      return session.result(page, { find })
    }),
  })

  ctx.actions.define({
    name: 'browser.snapshot',
    description: 'Read the current page (or a tab) again as an outline with refs. Pass find to get only the lines that mention a word, for long pages.',
    risk: 'read',
    input: z.object({ tab, find: z.string().optional() }),
    handler: ({ tab: id, find }) => attempt(async () => session.result(await session.page(id), { find })),
  })

  ctx.actions.define({
    name: 'browser.click',
    description: 'Click an element by its ref from the latest outline. Returns the page afterwards, with new refs.',
    risk: 'write',
    input: z.object({ ref, tab, double: z.boolean().default(false) }),
    approval: acts,
    handler: ({ ref: target, tab: id, double }) => attempt(async () => {
      const page = await session.page(id)
      const element = locate(page, target)
      await (double ? element.dblclick({ timeout: 8000 }) : element.click({ timeout: 8000 }))
      await session.settle(page)
      // A link that opens a new tab makes that tab the current one.
      return session.result(await session.page())
    }),
  })

  ctx.actions.define({
    name: 'browser.type',
    description: 'Type into a field by its ref, replacing what is in it; submit presses Enter afterwards. Returns the page afterwards.',
    risk: 'write',
    input: z.object({ ref, text: z.string(), submit: z.boolean().default(false), tab }),
    approval: acts,
    handler: ({ ref: target, text, submit, tab: id }) => attempt(async () => {
      const page = await session.page(id)
      const element = locate(page, target)
      await element.fill(text, { timeout: 8000 })
      if (submit) await element.press('Enter')
      await session.settle(page)
      return session.result(page)
    }),
  })

  ctx.actions.define({
    name: 'browser.select',
    description: 'Choose options in a select box by its ref, by their labels or values. Returns the page afterwards.',
    risk: 'write',
    input: z.object({ ref, values: z.array(z.string()).min(1), tab }),
    approval: acts,
    handler: ({ ref: target, values, tab: id }) => attempt(async () => {
      const page = await session.page(id)
      await locate(page, target).selectOption(values, { timeout: 8000 })
      await session.settle(page)
      return session.result(page)
    }),
  })

  ctx.actions.define({
    name: 'browser.press',
    description: 'Press a key or combination on the page, such as Enter, Escape, PageDown or Control+A. Returns the page afterwards.',
    risk: 'write',
    input: z.object({ key: z.string().min(1), tab }),
    approval: acts,
    handler: ({ key, tab: id }) => attempt(async () => {
      const page = await session.page(id)
      await page.keyboard.press(key)
      await session.settle(page)
      return session.result(page)
    }),
  })

  ctx.actions.define({
    name: 'browser.scroll',
    description: 'Scroll the page so the user sees another part of it, or so a page that loads more as you scroll does. The outline covers the whole page either way.',
    risk: 'read',
    input: z.object({ direction: z.enum(['down', 'up']).default('down'), tab }),
    handler: ({ direction, tab: id }) => attempt(async () => {
      const page = await session.page(id)
      await page.mouse.wheel(0, direction === 'down' ? VIEWPORT.height * 0.8 : -VIEWPORT.height * 0.8)
      await session.settle(page)
      return session.result(page, { snapshot: false })
    }),
  })

  ctx.actions.define({
    name: 'browser.back',
    description: 'Go back to the previous page in the tab. Returns that page.',
    risk: 'read',
    input: z.object({ tab }),
    handler: ({ tab: id }) => attempt(async () => {
      const page = await session.page(id)
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 })
      await session.settle(page)
      return session.result(page)
    }),
  })

  ctx.actions.define({
    name: 'browser.wait',
    description: 'Wait until some text shows on the page (up to 30 seconds), or for a number of seconds, for pages that load slowly. Returns the page.',
    risk: 'read',
    input: z.object({ text: z.string().optional(), seconds: z.number().min(0).max(30).optional(), tab }),
    handler: ({ text, seconds, tab: id }) => attempt(async () => {
      const page = await session.page(id)
      if (text) await page.getByText(text).first().waitFor({ timeout: (seconds ?? 30) * 1000 })
      else await page.waitForTimeout((seconds ?? 2) * 1000)
      return session.result(page)
    }),
  })

  ctx.actions.define({
    name: 'browser.tabs',
    description: 'List the open tabs with their ids, addresses and titles, and which one is current.',
    risk: 'read',
    input: z.object({}),
    handler: async () => ({ running: session.running, ...(session.program ? { browser: session.program } : {}), tabs: await session.tabs() }),
  })

  ctx.actions.define({
    name: 'browser.tab',
    description: 'Make a tab the current one, or close it.',
    risk: 'read',
    input: z.object({ id: z.string().min(1), close: z.boolean().default(false) }),
    handler: ({ id, close }) => attempt(async () => {
      const page = await session.page(id)
      if (!close) {
        await page.bringToFront()
        return session.result(page, { snapshot: false })
      }
      await page.close()
      const next = session.pages().at(-1)
      if (next) void session.show(next)
      return { closed: id, tabs: await session.tabs() }
    }),
  })

  ctx.actions.define({
    name: 'browser.screenshot',
    description: 'Save a screenshot of the page (the visible part, or the whole page) as a PNG file and show it in the Fairy workspace. Returns the file path.',
    risk: 'read',
    input: z.object({ tab, fullPage: z.boolean().default(false) }),
    handler: ({ tab: id, fullPage }) => attempt(async () => {
      const page = await session.page(id)
      const dir = join(ctx.storage.dirs.cache, 'browser')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
      await writeFile(file, await page.screenshot({ fullPage, timeout: 15_000 }))
      void session.show(page)
      return { path: file, tab: session.idOf(page), url: page.url() }
    }),
  })

  ctx.actions.define({
    name: 'browser.evaluate',
    description: 'Run JavaScript in the page and return its result as JSON, for what the outline does not show (an attribute, a computed value). The script is an expression or a function body that returns a value.',
    risk: 'dangerous',
    input: z.object({ script: z.string().min(1).max(20_000), tab }),
    handler: ({ script, tab: id }) => attempt(async () => {
      const page = await session.page(id)
      const body = /\breturn\b/.test(script) ? script : `return (${script})`
      // eslint-disable-next-line no-new-func -- runs in the page, as the action says
      const result = await page.evaluate(new Function(body) as () => unknown)
      void session.show(page)
      return { result: result === undefined ? null : result }
    }),
  })

  ctx.actions.define({
    name: 'browser.close',
    description: 'Close the browser and all its tabs. Sign-ins stay when the plugin keeps them.',
    risk: 'write',
    input: z.object({}),
    handler: async () => {
      await session.close()
      return { closed: true }
    },
  })

  // ---- for the dashboard ----

  ctx.actions.define({
    name: 'browser.frame',
    description: 'What the current tab looks like now, for the Fairy workspace; null when the browser is not running.',
    risk: 'read',
    fairy: false,
    input: z.object({}),
    handler: async () => (session.running ? (await session.show()) ?? null : null),
  })

  ctx.actions.define({
    name: 'browser.mouse',
    description: 'Click the current tab at a point of the viewport, in CSS pixels, as the user does on the picture in the Fairy workspace.',
    risk: 'write',
    fairy: false,
    input: z.object({ x: z.number().min(0), y: z.number().min(0), tab }),
    handler: ({ x, y, tab: id }) => attempt(async () => {
      const page = await session.page(id)
      await page.mouse.click(x, y)
      await session.settle(page)
      return session.result(await session.page(), { snapshot: false })
    }),
  })
}
