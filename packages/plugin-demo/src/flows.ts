import type {} from '@mushin/plugin-bots'

interface DemoNode {
  id: string
  type: string
  label?: string
  config?: Record<string, any>
  inputs?: Record<string, string>
}

export interface DemoFlow {
  name: string
  description: string
  nodes: DemoNode[]
  edges: { source: string; sourceHandle: string; target: string; targetHandle: string }[]
}

/** "Run `target` after `source` leaves through `output`." */
const then = (source: string, output: string, target: string) => ({ source, sourceHandle: `exec:${output}`, target, targetHandle: 'exec' })

const reply = (id: string, label: string, text: string, quote = false): DemoNode => ({ id, type: 'action.reply', label, config: { text, quote } })

export type DemoFlowKey = 'menu' | 'command' | 'keyword' | 'branch' | 'cooldown' | 'wait' | 'llm' | 'classify'

export const demoFlows: Record<DemoFlowKey, DemoFlow> = {
  menu: {
    name: '演示：命令菜单',
    description: '发送 /help 列出所有演示指令。最简单的流程：一个触发器加一个回复。',
    nodes: [
      { id: 'help', type: 'trigger.keyword', label: '/help', config: { keywords: ['/help', '/menu', '菜单'], mode: 'exact' } },
      reply('list', '指令列表', [
        '我是演示机器人，可以试试这些：',
        '/ping、/echo 你好 —— 命令回复',
        '早上好 —— 关键词触发',
        '/score 85 —— 条件分支',
        '/checkin —— 冷却与计数',
        '/quiz —— 等待回复（30 秒超时）',
        '/ai 讲个笑话 —— 大模型回复',
        '/客服 我要退款 —— 意图分类',
      ].join('\n')),
    ],
    edges: [then('help', 'next', 'list')],
  },
  command: {
    name: '演示：命令回复',
    description: '/ping 回复 pong；/echo <内容> 用正则捕获参数并原样回复。一个流程可以有多个触发器。',
    nodes: [
      { id: 'ping', type: 'trigger.keyword', label: '/ping', config: { keywords: ['/ping'], mode: 'exact' } },
      reply('pong', '回复 pong', 'pong！{{sys.user}} 🏓'),
      { id: 'echo', type: 'trigger.regex', label: '/echo <内容>', config: { pattern: '^/echo\\s+(.+)$', flags: 'is' } },
      reply('say', '复读参数', '{{echo.group1}}'),
    ],
    edges: [then('ping', 'next', 'pong'), then('echo', 'next', 'say')],
  },
  keyword: {
    name: '演示：关键词触发',
    description: '消息里包含「早上好」等关键词时引用原消息回复。开启了「同时交给其他插件」，大模型对话等插件仍会看到这条消息。',
    nodes: [
      {
        id: 'morning',
        type: 'trigger.keyword',
        label: '早上好',
        config: { keywords: ['早上好', '早安', 'good morning'], mode: 'contains', passThrough: true },
      },
      reply('greet', '问早', '{{sys.user}}，早上好！☀️ 今天也要元气满满。', true),
    ],
    edges: [then('morning', 'next', 'greet')],
  },
  branch: {
    name: '演示：条件分支',
    description: '/score <分数>：用「条件判断」比较分数，大于 59 走 true 分支，否则走 false 分支。',
    nodes: [
      { id: 'score', type: 'trigger.regex', label: '/score <分数>', config: { pattern: '^/score\\s+(\\d+)$', flags: 'i' } },
      { id: 'check', type: 'logic.compare', label: '及格了吗', config: { op: 'greater', value: '59' }, inputs: { a: '{{score.group1}}' } },
      reply('pass', '及格', '{{score.group1}} 分，及格了 🎉'),
      reply('fail', '不及格', '{{score.group1}} 分，还没及格，继续加油 💪'),
    ],
    edges: [then('score', 'next', 'check'), then('check', 'true', 'pass'), then('check', 'false', 'fail')],
  },
  cooldown: {
    name: '演示：冷却与计数',
    description: '/checkin 签到：每人每 60 秒只能签到一次（冷却），每次签到给用户变量 points 加 10。',
    nodes: [
      { id: 'checkin', type: 'trigger.keyword', label: '/checkin', config: { keywords: ['/checkin', '签到'], mode: 'exact' } },
      { id: 'cd', type: 'logic.cooldown', label: '60 秒冷却', config: { seconds: 60, scope: 'user' } },
      { id: 'points', type: 'data.increment', label: '积分 +10', config: { name: 'points', scope: 'user', by: 10 } },
      reply('done', '签到成功', '签到成功！{{sys.user}} 现在有 {{points.value}} 积分。'),
      reply('wait', '冷却中', '你刚签到过，一分钟后再来吧。'),
    ],
    edges: [then('checkin', 'next', 'cd'), then('cd', 'ready', 'points'), then('points', 'next', 'done'), then('cd', 'cooling', 'wait')],
  },
  wait: {
    name: '演示：等待回复',
    description: '/quiz 出一道题，等同一个人 30 秒内的下一条消息：答对、答错和超时各走一条分支。',
    nodes: [
      { id: 'quiz', type: 'trigger.keyword', label: '/quiz', config: { keywords: ['/quiz', '答题'], mode: 'exact' } },
      reply('ask', '出题', '一年有几个季节？30 秒内回复数字。'),
      { id: 'answer', type: 'logic.waitReply', label: '等待回答', config: { seconds: 30 } },
      { id: 'judge', type: 'logic.compare', label: '答案是 4 吗', config: { op: 'equals', value: '4' }, inputs: { a: '{{answer.text}}' } },
      reply('right', '答对', '答对了！🎯'),
      reply('wrong', '答错', '「{{answer.text}}」不对哦，答案是 4。'),
      reply('late', '超时', '时间到！答案是 4。'),
    ],
    edges: [
      then('quiz', 'next', 'ask'),
      then('ask', 'next', 'answer'),
      then('answer', 'reply', 'judge'),
      then('answer', 'timeout', 'late'),
      then('judge', 'true', 'right'),
      then('judge', 'false', 'wrong'),
    ],
  },
  llm: {
    name: '演示：大模型回复',
    description: '/ai <问题>：把问题交给大模型，再引用原消息回复它的回答。没有真实模型时可以用演示提供商。',
    nodes: [
      { id: 'ask', type: 'trigger.keyword', label: '/ai', config: { keywords: ['/ai'], mode: 'startsWith' } },
      {
        id: 'chat',
        type: 'ai.chat',
        label: '询问大模型',
        config: { systemPrompt: '你是一个友好的聊天机器人，回答简短。' },
        inputs: { prompt: '{{ask.rest}}' },
      },
      { id: 'answer', type: 'action.reply', label: '回复答案', config: { quote: true }, inputs: { text: '{{chat.reply}}' } },
    ],
    edges: [then('ask', 'next', 'chat'), then('chat', 'next', 'answer')],
  },
  classify: {
    name: '演示：意图分类',
    description: '/客服 <问题>：大模型判断是「退款」还是「发货」，各回一段固定话术；都不是时交给大模型自由回答。',
    nodes: [
      { id: 'support', type: 'trigger.keyword', label: '/客服', config: { keywords: ['/客服', '/support'], mode: 'startsWith' } },
      {
        id: 'intent',
        type: 'ai.classify',
        label: '判断意图',
        config: { labels: ['退款', '发货'], instructions: '退款：想退钱或退货。发货：询问物流或什么时候发货。' },
        inputs: { text: '{{support.rest}}' },
      },
      reply('refund', '退款话术', '退款请发一下订单号，我们会在 24 小时内处理。'),
      reply('ship', '发货话术', '订单一般 48 小时内发货，可以在订单页查看物流。'),
      { id: 'fallback', type: 'ai.chat', label: '自由回答', config: { systemPrompt: '你是网店客服，回答简短礼貌。' }, inputs: { prompt: '{{support.rest}}' } },
      { id: 'other', type: 'action.reply', label: '回复', inputs: { text: '{{fallback.reply}}' } },
    ],
    edges: [
      then('support', 'next', 'intent'),
      then('intent', '退款', 'refund'),
      then('intent', '发货', 'ship'),
      then('intent', 'other', 'fallback'),
      then('fallback', 'next', 'other'),
    ],
  },
}
