import { describe, expect, it } from 'vitest'
import { chatFlow, LegacyConfig, legacySettings } from '../src/legacy'

const types = (settings: Partial<LegacyConfig>) => chatFlow(LegacyConfig.parse(settings)).nodes.map((node) => node.type)

describe('LLM chat settings as a flow', () => {
  it('maps the default settings to message → cooldown → rate limit → quota → LLM → reply', () => {
    const { nodes, edges } = chatFlow(LegacyConfig.parse({}))
    expect(nodes.map((node) => node.type)).toEqual(['trigger.message', 'logic.cooldown', 'logic.rateLimit', 'logic.dailyQuota', 'ai.chat', 'action.reply'])
    expect(edges.map((edge) => `${edge.source}:${edge.sourceHandle}`)).toEqual(['message:exec:next', 'cooldown:exec:ready', 'rate:exec:ok', 'quota:exec:ok', 'ask:exec:next'])
    expect(nodes[0]).toMatchObject({ priority: -100, config: { when: 'mention' } })
    expect(nodes.find((node) => node.id === 'ask')?.config).toMatchObject({ history: 10, historySource: 'chat', maxTokens: 2000, maxInputChars: 1000, systemPrompt: '' })
  })

  it('leaves out the limits that are off and keeps the rest of the settings', () => {
    expect(types({ cooldown: 0, userLimit: 0, dailyReplies: 0 })).toEqual(['trigger.message', 'ai.chat', 'action.reply'])
    expect(chatFlow(LegacyConfig.parse({ trigger: 'always', privateChat: false, groups: ['1'] })).nodes[0].config).toEqual({ when: 'group', groups: ['1'], ignoreUsers: [], skipCommands: true })
    expect(chatFlow(LegacyConfig.parse({ privateChat: false })).nodes[0].config.when).toBe('groupMention')
    const notice = chatFlow(LegacyConfig.parse({ limitNotice: 'slow down' }))
    expect(notice.edges).toContainEqual({ source: 'rate', sourceHandle: 'exec:limited', target: 'firstLimited', targetHandle: 'exec' })
    expect(notice.nodes.find((node) => node.id === 'notice')?.config.text).toBe('slow down')
  })

  it('reads only the old settings from a config', () => {
    expect(legacySettings({ cooldown: 1, other: true })).toEqual({ cooldown: 1 })
    expect(legacySettings(undefined)).toEqual({})
  })
})
