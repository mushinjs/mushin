import { z } from '@mushin/core'

/** Where a skill comes from: shipped with the Agent, added by a plugin, or written by the user. */
export type SkillSource = 'builtin' | 'plugin' | 'user'

/** A reusable way of doing something; picked with `$`, its instructions go into that one message. */
export interface AgentSkill {
  id: string
  name: string
  /** One line: what it is for. */
  description: string
  /** The steps, in Markdown. */
  instructions: string
  /** When to use it, for people picking one. */
  whenToUse?: string
  /** Actions it tends to use, e.g. `bots.logs`. */
  tools?: string[]
  /** Scene keys where it is recommended, e.g. `botDetail`. */
  scenes?: string[]
  source: SkillSource
  /** The plugin that added it. */
  plugin?: string
  /** Off: not offered with `$`. */
  enabled: boolean
}

/** What a plugin passes to `ctx.agent.defineSkill()`. */
export type SkillDefinition = Omit<AgentSkill, 'source' | 'plugin' | 'enabled'>

export const skillFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(''),
  instructions: z.string().min(1).max(20_000).describe('The steps, in Markdown'),
  whenToUse: z.string().max(500).optional(),
  tools: z.array(z.string()).max(30).optional().describe('Action names it tends to use, e.g. bots.logs'),
  scenes: z.array(z.string()).max(20).optional().describe('Scene keys where it is recommended: overview, bots, botDetail, providers, flows, flowEditor, plugins, logs, personas, knowledge, agent'),
}

export const skillInput = z.object(skillFields)

/** Skills that ship with the Agent. */
export const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    id: 'diagnose-bot',
    name: '排查机器人连接',
    description: '机器人离线、连不上 NapCat 或不回复时，按步骤找出原因',
    whenToUse: '机器人状态不是在线，或者在线但不回复消息',
    instructions: [
      '1. 用 bots.list 找到这个机器人，记下状态和错误信息。',
      '2. 用 bots.logs 读它最近的日志：连接地址、NapCat 的 self id、令牌是否被拒绝、登录记录。',
      '3. 根据日志判断：地址或端口不对、NapCat 没开 WebSocket、令牌不一致、消息格式不是 array、反向连接地址不对。',
      '4. 在线但不回复时，用 bots.plugins.list 看插件是否启用，用 flows.route 看一条消息会被谁处理。',
      '5. 给出最可能的原因和具体修改步骤；能直接改的配置（地址、令牌）先说明再改，改完用 bots.get 确认状态。',
    ].join('\n'),
    tools: ['bots.list', 'bots.logs', 'bots.get', 'bots.plugins.list', 'flows.route'],
    scenes: ['bots', 'botDetail'],
  },
  {
    id: 'build-flow',
    name: '搭建流程',
    description: '把一段描述变成可运行的对话流程，并测试通过',
    whenToUse: '想让机器人在某种消息下做某件事',
    instructions: [
      '1. 先问清楚（或从描述中确定）：什么消息触发、要回复什么、用在哪个机器人上。',
      '2. 用 flows.nodeTypes 读节点类型，选触发器和动作节点；需要计数、冷却、限额时用对应的逻辑节点。',
      '3. 用 flows.create 创建流程并绑定机器人，节点之间用 exec 连线，值用 {{节点.输出}} 引用。',
      '4. 用 flows.test 发几条样例消息（包括不该触发的），检查路径和回复；有问题就用 flows.update 修正后再测。',
      '5. 用 ui.navigate 打开 /flows/<id>，简要说明流程怎么工作。',
    ].join('\n'),
    tools: ['flows.nodeTypes', 'flows.create', 'flows.test', 'flows.update', 'ui.navigate'],
    scenes: ['flows', 'flowEditor'],
  },
  {
    id: 'fix-flow',
    name: '修复流程问题',
    description: '读出流程的校验问题，逐个修好并重新测试',
    whenToUse: '流程编辑器里有错误或警告',
    instructions: [
      '1. 用 flows.get 读当前流程（上下文里有它的 id）和它的 issues。',
      '2. 逐条说明每个问题的原因：缺少节点类型时说明要启用哪个插件；引用不存在的输出时找到正确的节点 id；被其他触发器挡住时用 flows.triggers 看顺序。',
      '3. 能修的用 flows.update 修，修改前简要说明要改什么。',
      '4. 用 flows.test 验证，然后总结改了什么。',
    ].join('\n'),
    tools: ['flows.get', 'flows.update', 'flows.test', 'flows.triggers'],
    scenes: ['flowEditor'],
  },
  {
    id: 'connect-provider',
    name: '连接模型提供商',
    description: '添加一个大模型提供商并测试通过',
    whenToUse: '还没有提供商，或者想换一个模型服务',
    instructions: [
      '1. 问用户要用哪家服务（DeepSeek、通义千问、Moonshot、OpenAI、Anthropic、本地 Ollama）和 API 密钥；本地 Ollama 不需要密钥。',
      '2. 用 providers.types 读配置格式，用 providers.create 创建，填好接口地址和模型。',
      '3. 用 providers.test 测试；失败时根据错误说明原因（密钥、地址、模型名、网络）。',
      '4. 成功后告诉用户延迟，并询问是否设为默认。',
    ].join('\n'),
    tools: ['providers.types', 'providers.create', 'providers.test', 'providers.setDefault'],
    scenes: ['providers', 'setup'],
  },
]
