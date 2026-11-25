import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { actionLabel, actionTarget, askAnswer, diff, numbered, unwrapCall } from '../src/components/fairy/records'
import en from '../src/locales/en'
import zhCN from '../src/locales/zh-CN'

function i18n(locale: 'en' | 'zh-CN') {
  const instance = createI18n({ legacy: false, locale, messages: { en, 'zh-CN': zhCN } as any, missingWarn: false, fallbackWarn: false })
  return { t: instance.global.t as any, te: instance.global.te as any }
}

describe('action labels', () => {
  const zh = i18n('zh-CN')
  const english = i18n('en')
  const label = (action: string, lang = zh) => actionLabel(action, lang.t, lang.te)

  it('puts a verb on a thing', () => {
    expect(label('bots.create')).toBe('创建机器人')
    expect(label('bots.list')).toBe('查看机器人列表')
    expect(label('bots.plugins.enable')).toBe('启用机器人插件')
    expect(label('kb.chunks.merge')).toBe('合并知识片段')
  })

  it('spaces Chinese from Latin words', () => {
    expect(label('mcp.servers.restart')).toBe('重启 MCP 服务')
    expect(label('mcp.servers.list')).toBe('查看 MCP 服务列表')
  })

  it('looks at a thing named alone', () => {
    expect(label('bots.messages')).toBe('查看机器人消息')
    expect(label('system.info')).toBe('查看系统信息')
  })

  it('uses a name of its own where verb and thing do not fit', () => {
    expect(label('terminal.run')).toBe('运行命令')
    expect(label('flows.run')).toBe('查看一次运行的详情')
    expect(label('bots.groupChoices')).toBe('查看可选的群聊')
    expect(label('flows.choices')).toBe('查看可选的流程')
  })

  it('reads as English, with plurals where the verb wants them', () => {
    expect(label('bots.create', english)).toBe('Create bot')
    expect(label('bots.list', english)).toBe('List bots')
    expect(label('flows.tests.generate', english)).toBe('Generate test cases')
  })

  it('falls back to the id', () => {
    expect(label('someplugin.doThing')).toBe('someplugin.doThing')
  })

  it('names every built-in action', () => {
    const actions = ['bots.adapters', 'bots.channels', 'bots.commands.run', 'bots.contacts', 'bots.create', 'bots.delete', 'bots.forward', 'bots.get', 'bots.groupChoices', 'bots.list', 'bots.logs', 'bots.media', 'bots.messages', 'bots.plugins.configure', 'bots.plugins.disable', 'bots.plugins.enable', 'bots.plugins.list', 'bots.plugins.project', 'bots.plugins.setProject', 'bots.runs', 'bots.sandbox', 'bots.send', 'bots.start', 'bots.stop', 'bots.tryCommand', 'bots.update', 'bots.usage', 'bots.userChoices', 'commands.list', 'database.backup', 'database.export', 'database.remove', 'database.rows', 'database.status', 'database.tables', 'database.update', 'flows.activity', 'flows.choices', 'flows.create', 'flows.delete', 'flows.get', 'flows.history', 'flows.list', 'flows.nodeTypes', 'flows.preview', 'flows.route', 'flows.run', 'flows.runs', 'flows.setTriggerOrder', 'flows.stop', 'flows.tables.choices', 'flows.tables.define', 'flows.tables.drop', 'flows.tables.fieldChoices', 'flows.tables.list', 'flows.test', 'flows.tests.autoRun', 'flows.tests.create', 'flows.tests.delete', 'flows.tests.generate', 'flows.tests.list', 'flows.tests.run', 'flows.tests.update', 'flows.triggers', 'flows.update', 'kb.candidates.accept', 'kb.candidates.list', 'kb.candidates.reject', 'kb.choices', 'kb.chunks.add', 'kb.chunks.list', 'kb.chunks.merge', 'kb.chunks.remove', 'kb.chunks.update', 'kb.create', 'kb.delete', 'kb.docs.add', 'kb.docs.list', 'kb.docs.remove', 'kb.docs.reparse', 'kb.flowChoices', 'kb.graph', 'kb.learn', 'kb.list', 'kb.reindex', 'kb.search', 'kb.update', 'kb.useInFlow', 'logs.recent', 'mcp.servers.create', 'mcp.servers.delete', 'mcp.servers.list', 'mcp.servers.restart', 'mcp.servers.update', 'mcp.tools.update', 'permissions.chats', 'permissions.check', 'permissions.get', 'permissions.members.act', 'permissions.members.list', 'permissions.members.set', 'permissions.rules.create', 'permissions.rules.delete', 'permissions.rules.list', 'permissions.rules.update', 'permissions.update', 'personas.botSettings', 'personas.choices', 'personas.create', 'personas.delete', 'personas.export', 'personas.get', 'personas.import', 'personas.list', 'personas.resolve', 'personas.setChat', 'personas.update', 'personas.updateBotSettings', 'plugins.catalog', 'plugins.configure', 'plugins.dependencies', 'plugins.disable', 'plugins.enable', 'plugins.folders', 'plugins.folders.set', 'plugins.list', 'plugins.new', 'plugins.provides', 'plugins.reload', 'plugins.remove', 'providers.choices', 'providers.create', 'providers.createProfile', 'providers.decide', 'providers.decideChoices', 'providers.delete', 'providers.deleteProfile', 'providers.embedChoices', 'providers.list', 'providers.models', 'providers.setDefault', 'providers.test', 'providers.types', 'providers.update', 'providers.updateProfile', 'stats.overview', 'stats.performance', 'stats.series', 'stats.top', 'system.info', 'ui.ask', 'ui.highlight', 'ui.navigate', 'ui.panel', 'terminal.hosts.list', 'terminal.hosts.check', 'terminal.hosts.forget', 'terminal.run', 'terminal.start', 'terminal.output', 'terminal.write', 'terminal.stop', 'terminal.processes', 'terminal.processes.remove', 'files.list', 'files.read', 'files.search', 'files.write', 'files.edit', 'browser.open', 'browser.snapshot', 'browser.click', 'browser.type', 'browser.select', 'browser.press', 'browser.scroll', 'browser.back', 'browser.wait', 'browser.tabs', 'browser.tab', 'browser.screenshot', 'browser.evaluate', 'browser.close', 'browser.frame', 'browser.mouse', 'search_tools', 'fairy.report']
    for (const lang of [zh, english]) {
      const unnamed = actions.filter((action) => label(action, lang) === action)
      expect(unnamed).toEqual([])
    }
  })
})

describe('what a call works on', () => {
  const known = { bots: [{ id: 'b1', name: '小助手' }], providers: [{ id: 'p1', name: 'OpenAI' }], profiles: [] } as any

  it('names a bot or provider by its id', () => {
    expect(actionTarget('bots.update', { id: 'b1' }, known)).toBe('小助手')
    expect(actionTarget('bots.send', { bot: 'b1', text: 'hi' }, known)).toBe('小助手')
    expect(actionTarget('providers.test', { id: 'p1' }, known)).toBe('OpenAI')
  })

  it('takes a name, title or search words from the input', () => {
    expect(actionTarget('bots.create', { name: '新机器人' }, known)).toBe('新机器人')
    expect(actionTarget('kb.search', { query: '退款' }, known)).toBe('“退款”')
    expect(actionTarget('stats.overview', {}, known)).toBe('')
  })
})

describe('records', () => {
  it('shows a call made through call_tool as the tool it ran', () => {
    expect(unwrapCall('call_tool', { name: 'kb__search', input: { query: 'x' } })).toEqual({ action: 'kb.search', input: { query: 'x' } })
    expect(unwrapCall('bots.list', {})).toEqual({ action: 'bots.list', input: {} })
  })

  it('reads the answer to a question', () => {
    expect(askAnswer({ choice: 1, label: '是' })).toEqual({ kind: 'choice', index: 1, label: '是' })
    expect(askAnswer({ other: '都行' })).toEqual({ kind: 'other', text: '都行' })
    expect(askAnswer({ skipped: true, note: 'x' })).toEqual({ kind: 'skipped', note: 'x' })
    expect(askAnswer({ cancelled: true })).toEqual({ kind: 'cancelled' })
    expect(askAnswer(undefined)).toBeUndefined()
  })

  it('numbers lines and diffs a replacement', () => {
    expect(numbered('a\nb', 10)).toEqual([{ text: 'a', no: 10 }, { text: 'b', no: 11 }])
    expect(diff('old', 'new\nmore')).toEqual([{ text: 'old', mark: '-' }, { text: 'new', mark: '+' }, { text: 'more', mark: '+' }])
  })
})
