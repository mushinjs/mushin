import { field, z } from '@mushin/core'

export const exampleSchema = z.object({
  user: z.string().describe('What someone says'),
  assistant: z.string().describe('How the persona answers'),
})

/** The editable fields of a persona. */
export const personaFields = {
  name: z.string().trim().min(1).max(60).describe('Shown in lists, in /persona and in reply provenance'),
  avatar: z.string().max(400_000).optional().describe('Image URL or data: URL'),
  description: z.string().max(500).optional().describe('One line for people choosing a persona; not sent to the model'),
  prompt: z.string().min(1).max(20_000).describe('System prompt: character, voice, background. Supports {bot.name}, {user.name}, {user.id}, {group.id}, {time}, {date} and {weekday}'),
  examples: z.array(exampleSchema).max(20).optional().describe('Example exchanges, sent before the conversation (few-shot)'),
  avoid: z.string().max(5000).optional().describe('Things the persona must never say or do; added to the prompt'),
  provider: z.string().optional().describe('Provider id the persona prefers; empty uses the bot\'s'),
  model: z.string().optional().describe('Model the persona prefers'),
  temperature: z.number().min(0).max(2).optional(),
  tags: z.array(z.string()).max(20).optional(),
}

export const personaInput = z.object(personaFields)
export type PersonaInput = z.input<typeof personaInput>

export interface Persona extends z.infer<typeof personaInput> {
  id: string
  examples: { user: string; assistant: string }[]
  tags: string[]
  createdAt: number
  updatedAt: number
}

/** When a rule picks its persona: in these groups, for these users, in private chats, or between two times of day. */
export const ruleSchema = z.object({
  id: z.string().optional(),
  when: z.enum(['group', 'user', 'private', 'time']).meta(field('When', undefined, {
    'zh-CN': { title: '条件', options: { group: '在这些群', user: '对这些用户', private: '私聊', time: '时间段' } },
  }, { options: { group: 'In these groups', user: 'For these users', private: 'Private chats', time: 'Time of day' } })),
  ids: z.array(z.string()).optional().describe('Group or user ids, for group and user rules'),
  from: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('Start time HH:MM, for time rules'),
  to: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('End time HH:MM; earlier than from means it runs past midnight'),
  persona: z.string().describe('Persona id'),
})

export type PersonaRule = z.infer<typeof ruleSchema> & { id: string }

/** How a bot picks its persona. */
export interface BotPersonaSettings {
  /** Personas `/persona` can switch to; the default and the rules' personas count too. */
  personas: string[]
  /** For chats no rule matches; none means plain LLM prompts. */
  default?: string
  /** The first rule that matches wins. */
  rules: PersonaRule[]
  /** `/persona` lists and switches personas in a chat; who may switch. */
  command: { enabled: boolean; role: 'user' | 'admin' | 'master' }
}

export const DEFAULT_SETTINGS: BotPersonaSettings = { personas: [], rules: [], command: { enabled: true, role: 'admin' } }

/** Why a chat gets its persona. */
export type PersonaReason = 'chat' | 'rule' | 'default'
