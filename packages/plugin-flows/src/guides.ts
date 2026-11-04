/**
 * Tutorials of the built-in node types: a small example flow that the editor runs as a test and
 * plays back when someone hovers the node in the node list, with one caption per step.
 */
import type { NodeGuide } from './types'

const say = (text: string) => ({ id: 'say', type: 'action.reply', config: { text } })

export const BUILTIN_GUIDES: Record<string, NodeGuide> = {
  'trigger.message': {
    example: { nodes: [{ id: 'on', type: 'trigger.message' }, say('收到：{{on.text}}')], edges: [['on', 'say']], input: { text: '今天天气不错' } },
    captions: [
      { en: 'Any message starts the flow; its text becomes an output', 'zh-CN': '任何消息都会启动流程，消息内容成为输出' },
      { en: 'The next node reads it with a reference', 'zh-CN': '后面的节点通过引用读取它' },
    ],
  },
  'trigger.keyword': {
    example: {
      nodes: [{ id: 'kw', type: 'trigger.keyword', config: { keywords: ['天气'], mode: 'startsWith' } }, say('正在查{{kw.rest}}的天气')],
      edges: [['kw', 'say']],
      input: { text: '天气 上海' },
    },
    captions: [
      { en: 'A message starting with "天气" matches; the text after it is "rest"', 'zh-CN': '以“天气”开头的消息命中，后面的内容就是“关键词后的内容”' },
      { en: 'The reply uses what came after the keyword', 'zh-CN': '回复里用上了关键词后的内容' },
    ],
  },
  'trigger.command': {
    example: {
      nodes: [
        { id: 'cmd', type: 'trigger.command', config: { name: '签到', args: [{ name: '心情', type: 'text', optional: true }] } },
        say('签到成功！今天的心情：{{cmd.心情}}'),
      ],
      edges: [['cmd', 'say']],
      input: { text: '/签到 开心' },
    },
    captions: [
      { en: 'The prefix and name match; each argument becomes an output of the same name', 'zh-CN': '前缀和指令名匹配，每个参数都成为同名输出' },
      { en: 'The reply reads the argument', 'zh-CN': '回复读取了参数' },
    ],
  },
  'trigger.regex': {
    example: {
      nodes: [{ id: 're', type: 'trigger.regex', config: { pattern: '^掷(\\d+)$' } }, say('掷了一个 {{re.group1}} 面的骰子')],
      edges: [['re', 'say']],
      input: { text: '掷20' },
    },
    captions: [
      { en: 'The pattern matches; each (group) becomes an output', 'zh-CN': '正则匹配成功，每个括号分组成为一个输出' },
      { en: 'The reply uses group 1', 'zh-CN': '回复用上了分组 1' },
    ],
  },
  'logic.if': {
    example: {
      nodes: [
        { id: 'on', type: 'trigger.message' },
        { id: 'msg', type: 'data.message' },
        { id: 'if', type: 'logic.if', inputs: { condition: '{{msg.isPrivate}}' } },
        say('私聊收到'),
        { id: 'say2', type: 'action.reply', config: { text: '群里收到' } },
      ],
      edges: [['on', 'msg'], ['msg', 'if'], ['if', 'say', 'true'], ['if', 'say2', 'false']],
      input: { text: '在吗', private: true },
      repeat: [{ text: '在吗' }],
    },
    captions: [
      { en: 'In a private chat the condition is true, so the run takes the true track', 'zh-CN': '私聊里条件为真，走 true 这条路' },
      { en: 'In a group it is false, so the same message goes the other way', 'zh-CN': '群里条件为假，同一句话走另一条路' },
    ],
  },
  'logic.compare': {
    example: {
      nodes: [
        { id: 'on', type: 'trigger.message' },
        { id: 'cmp', type: 'logic.compare', config: { op: 'contains', value: '谢谢' }, inputs: { a: '{{on.text}}' } },
        say('不客气～'),
      ],
      edges: [['on', 'cmp'], ['cmp', 'say', 'true']],
      input: { text: '谢谢你的帮助' },
      repeat: [{ text: '你好呀' }],
    },
    captions: [
      { en: 'A is the message, B the fixed value: it contains "谢谢", so true', 'zh-CN': 'A 是消息，B 是固定值：包含“谢谢”，结果为真' },
      { en: 'This one does not, so false', 'zh-CN': '这句不包含，结果为假' },
    ],
  },
  'logic.random': {
    example: {
      nodes: [{ id: 'on', type: 'trigger.message' }, { id: 'rnd', type: 'logic.random', config: { percent: 50 } }, say('今天运气不错！'), { id: 'say2', type: 'action.reply', config: { text: '再接再厉' } }],
      edges: [['on', 'rnd'], ['rnd', 'say', 'yes'], ['rnd', 'say2', 'no']],
      input: { text: '抽签' },
      repeat: [{ text: '抽签' }, { text: '抽签' }, { text: '抽签' }],
    },
    captions: [
      { en: 'Each message spins again: 50% "yes", 50% "no"', 'zh-CN': '每条消息都重新抽一次：50% 走 yes，50% 走 no' },
      { en: 'Nothing is remembered between spins', 'zh-CN': '每次互不影响，不记上一次的结果' },
      { en: 'The chance is set in its settings', 'zh-CN': '概率在设置里调整' },
      { en: 'At 100% it always goes "yes", at 0% always "no"', 'zh-CN': '设成 100% 总是 yes，0% 总是 no' },
    ],
  },
  'logic.cooldown': {
    example: {
      nodes: [
        { id: 'on', type: 'trigger.message' },
        { id: 'cd', type: 'logic.cooldown', config: { seconds: 30 } },
        say('好的！'),
        { id: 'slow', type: 'action.reply', config: { text: '歇一会儿再来' } },
      ],
      edges: [['on', 'cd'], ['cd', 'say', 'ready'], ['cd', 'slow', 'cooling']],
      input: { text: '来点音乐' },
      repeat: [{ text: '再来一首' }],
    },
    captions: [
      { en: 'It is ready: the message passes and a 30-second timer starts', 'zh-CN': '处于可用状态：消息通过，同时开始 30 秒冷却' },
      { en: 'The timer is still running, so the next message goes to "cooling"', 'zh-CN': '冷却还没结束，下一条走 cooling' },
    ],
  },
  'logic.rateLimit': {
    example: {
      nodes: [
        { id: 'on', type: 'trigger.message' },
        { id: 'rl', type: 'logic.rateLimit', config: { limit: 3, seconds: 60 } },
        say('还能用 {{rl.remaining}} 次'),
        { id: 'stop', type: 'action.reply', config: { text: '太快了，{{rl.retryAfter}} 秒后再试' } },
      ],
      edges: [['on', 'rl'], ['rl', 'say', 'ok'], ['rl', 'stop', 'limited']],
      input: { text: '查询' },
      repeat: [{ text: '查询' }, { text: '查询' }, { text: '查询' }],
    },
    captions: [
      { en: 'Each message takes one of the 3 uses in this minute', 'zh-CN': '每条消息占用本分钟 3 次中的一次' },
      { en: 'Second use', 'zh-CN': '第二次' },
      { en: 'Third use: the window is full', 'zh-CN': '第三次，额度用满' },
      { en: 'The fourth goes to "limited" until the window moves on', 'zh-CN': '第四次走 limited，等时间窗口过去才恢复' },
    ],
  },
  'logic.dailyQuota': {
    example: {
      nodes: [
        { id: 'on', type: 'trigger.message' },
        { id: 'q', type: 'logic.dailyQuota', config: { times: 3 } },
        say('今天第 {{q.used}} 次'),
        { id: 'stop', type: 'action.reply', config: { text: '今天的次数用完了，明天再来' } },
      ],
      edges: [['on', 'q'], ['q', 'say', 'ok'], ['q', 'stop', 'exhausted']],
      input: { text: '画一张图' },
      repeat: [{ text: '再画一张' }, { text: '再画一张' }, { text: '再画一张' }],
    },
    captions: [
      { en: 'Today\'s quota is 3; this is the first', 'zh-CN': '每天 3 次，这是第一次' },
      { en: 'Second', 'zh-CN': '第二次' },
      { en: 'Third: today\'s quota is used up', 'zh-CN': '第三次，今天的额度用完' },
      { en: 'Until midnight every message goes to "exhausted"', 'zh-CN': '零点之前都走 exhausted，零点后重置' },
    ],
  },
  'logic.delay': {
    example: {
      nodes: [{ id: 'on', type: 'trigger.message' }, say('让我想想…'), { id: 'wait', type: 'logic.delay', config: { seconds: 1 } }, { id: 'say2', type: 'action.reply', config: { text: '想好了！' } }],
      edges: [['on', 'say'], ['say', 'wait'], ['wait', 'say2']],
      input: { text: '讲个笑话' },
    },
    captions: [
      { en: 'A message arrives', 'zh-CN': '收到一条消息' },
      { en: 'A first reply goes out', 'zh-CN': '先回复一句' },
      { en: 'The run pauses for a second', 'zh-CN': '暂停 1 秒' },
      { en: 'Then it goes on', 'zh-CN': '然后继续' },
    ],
  },
  'logic.waitReply': {
    example: {
      nodes: [
        { id: 'on', type: 'trigger.keyword', config: { keywords: ['点餐'] } },
        say('想吃什么？'),
        { id: 'wait', type: 'logic.waitReply' },
        { id: 'say2', type: 'action.reply', config: { text: '好的，一份{{wait.text}}' } },
      ],
      edges: [['on', 'say'], ['say', 'wait'], ['wait', 'say2', 'reply']],
      input: { text: '点餐' },
      replies: ['牛肉面'],
    },
    captions: [
      { en: 'The keyword starts the flow', 'zh-CN': '关键词启动流程' },
      { en: 'The bot asks a question', 'zh-CN': '机器人提问' },
      { en: 'The run waits for the same person\'s next message', 'zh-CN': '等待同一个人的下一条消息' },
      { en: 'The answer is an output for the next nodes', 'zh-CN': '回答成为输出，供后面的节点使用' },
    ],
  },
  'data.text': {
    example: {
      nodes: [
        { id: 'kw', type: 'trigger.keyword', config: { keywords: ['我叫'], mode: 'startsWith' } },
        { id: 'tpl', type: 'data.text', config: { template: '欢迎你，{a}！' }, inputs: { a: '{{kw.rest}}' } },
        { id: 'say', type: 'action.reply', inputs: { text: '{{tpl.text}}' } },
      ],
      edges: [['kw', 'tpl'], ['tpl', 'say']],
      input: { text: '我叫小明' },
    },
    captions: [
      { en: 'The keyword matches; the rest is the name', 'zh-CN': '关键词命中，后面的内容是名字' },
      { en: '{a} in the text is filled from input a', 'zh-CN': '文本里的 {a} 由输入 a 填入' },
      { en: 'The reply sends the built text', 'zh-CN': '回复发出拼好的文本' },
    ],
  },
  'data.message': {
    example: {
      nodes: [{ id: 'on', type: 'trigger.message' }, { id: 'msg', type: 'data.message' }, say('你的 ID 是 {{msg.userId}}')],
      edges: [['on', 'msg'], ['msg', 'say']],
      input: { text: '我是谁', userId: '12345' },
    },
    captions: [
      { en: 'A message arrives', 'zh-CN': '收到一条消息' },
      { en: 'Message info gives the sender, the chat and more', 'zh-CN': '“消息信息”给出发送者、会话等信息' },
      { en: 'The reply uses the sender\'s id', 'zh-CN': '回复用上了发送者 ID' },
    ],
  },
  'data.setVar': {
    example: {
      nodes: [
        { id: 'kw', type: 'trigger.keyword', config: { keywords: ['记住'], mode: 'startsWith' } },
        { id: 'set', type: 'data.setVar', config: { name: 'note', scope: 'user' }, inputs: { value: '{{kw.rest}}' } },
        say('记住了'),
      ],
      edges: [['kw', 'set'], ['set', 'say']],
      input: { text: '记住 明天开会' },
    },
    captions: [
      { en: 'The keyword matches', 'zh-CN': '关键词命中' },
      { en: 'The rest is saved in the variable "note", one per user', 'zh-CN': '后面的内容存进变量 note，每个用户一份' },
      { en: 'Later runs can read it with Get variable', 'zh-CN': '以后的运行可以用“读取变量”取出' },
    ],
  },
  'data.getVar': {
    example: {
      nodes: [
        { id: 'kw', type: 'trigger.keyword', config: { keywords: ['我说过什么'] } },
        { id: 'get', type: 'data.getVar', config: { name: 'note', scope: 'user', fallback: '（还没记过）' } },
        say('你让我记住：{{get.value}}'),
      ],
      edges: [['kw', 'get'], ['get', 'say']],
      input: { text: '我说过什么' },
    },
    captions: [
      { en: 'The keyword matches', 'zh-CN': '关键词命中' },
      { en: 'Reads "note"; before it is set, the fallback is used', 'zh-CN': '读取变量 note；还没设置时使用“未设置时”的值' },
      { en: 'The reply shows the value', 'zh-CN': '回复显示读到的值' },
    ],
  },
  'data.increment': {
    example: {
      nodes: [
        { id: 'cmd', type: 'trigger.command', config: { name: '打卡' } },
        { id: 'inc', type: 'data.increment', config: { name: 'days', scope: 'user' } },
        say('已打卡 {{inc.value}} 天'),
      ],
      edges: [['cmd', 'inc'], ['inc', 'say']],
      input: { text: '/打卡' },
      repeat: [{ text: '/打卡' }, { text: '/打卡' }],
    },
    captions: [
      { en: 'The variable "days" starts at 0 and becomes 1', 'zh-CN': '变量 days 从 0 加到 1' },
      { en: 'It is kept between runs, so next time it is 2', 'zh-CN': '变量会保存下来，下次变成 2' },
      { en: 'Each person has their own count (scope: per user)', 'zh-CN': '作用范围是“每个用户”，每人各数各的' },
    ],
  },
  'ai.chat': {
    example: {
      nodes: [{ id: 'on', type: 'trigger.message', config: { when: 'mention' } }, { id: 'ai', type: 'ai.chat' }, { id: 'say', type: 'action.reply', inputs: { text: '{{ai.reply}}' } }],
      edges: [['on', 'ai'], ['ai', 'say']],
      input: { text: '推荐一本书', private: true },
      llm: ['试试《小王子》，短小又温暖。'],
    },
    captions: [
      { en: 'A message to the bot arrives', 'zh-CN': '收到发给机器人的消息' },
      { en: 'The prompt blocks and the message go to the model', 'zh-CN': '提示词块和这条消息一起发给模型' },
      { en: 'The model\'s reply is sent', 'zh-CN': '发出模型的回复' },
    ],
  },
  'ai.classify': {
    example: {
      nodes: [
        { id: 'on', type: 'trigger.message' },
        { id: 'cls', type: 'ai.classify', config: { labels: ['问候', '提问'] }, inputs: { text: '{{on.text}}' } },
        { id: 'hi', type: 'action.reply', config: { text: '你好呀' } },
        say('我来回答你的问题'),
      ],
      edges: [['on', 'cls'], ['cls', 'hi', '问候'], ['cls', 'say', '提问']],
      input: { text: '怎么设置提醒？' },
      repeat: [{ text: '早上好' }],
      llm: ['提问', '问候'],
    },
    captions: [
      { en: 'The model reads the message and picks the label "提问"', 'zh-CN': '模型读了消息，选出标签“提问”' },
      { en: 'A greeting lands on "问候"; each label is its own branch', 'zh-CN': '问候语落到“问候”，每个标签都是一条分支' },
    ],
  },
  'action.reply': {
    example: { nodes: [{ id: 'kw', type: 'trigger.keyword', config: { keywords: ['早安'] } }, say('早安，{user}！[face:74]')], edges: [['kw', 'say']], input: { text: '早安', userName: '小明' } },
    captions: [
      { en: 'The keyword matches', 'zh-CN': '关键词命中' },
      { en: 'Replies in the same chat; {user} is the sender\'s name', 'zh-CN': '在同一个会话里回复，{user} 是发送者的名字' },
    ],
  },
  'action.send': {
    example: {
      nodes: [
        { id: 'kw', type: 'trigger.keyword', config: { keywords: ['通知'], mode: 'startsWith' } },
        { id: 'send', type: 'action.send', config: { targetType: 'group', targetId: '123456', text: '公告：{{kw.rest}}' } },
      ],
      edges: [['kw', 'send']],
      input: { text: '通知 今晚八点开会' },
    },
    captions: [
      { en: 'The keyword matches', 'zh-CN': '关键词命中' },
      { en: 'Sends to another chat, here group 123456', 'zh-CN': '发送到另一个会话，这里是群 123456' },
    ],
  },
}
