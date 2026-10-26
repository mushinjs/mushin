<script setup lang="ts">
import { NButton, NCard, NTabPane, NTabs, useMessage } from 'naive-ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'
import AgentMessage from './AgentMessage.vue'

const { t, locale } = useI18n()
const message = useMessage()
const agent = useAgentStore()

const fence = '```'

/** Each example is what the Agent would write; the preview is how the dock shows it. */
const examples = computed(() => {
  const zh = locale.value === 'zh-CN'
  return [
    {
      id: 'markdown',
      source: zh
        ? '## 机器人状态\n\n**测试机器人** 在线，开启了 2 个插件：\n\n| 插件 | 状态 |\n| --- | --- |\n| 大模型对话 | 运行中 |\n| 流程 | 运行中 |\n\n> 提示：可以在 [机器人页](/bots) 查看详情。'
        : '## Bot status\n\n**Test bot** is online with 2 plugins:\n\n| Plugin | Status |\n| --- | --- |\n| LLM chat | active |\n| Flows | active |\n\n> Tip: see the [bots page](/bots) for details.',
    },
    {
      id: 'code',
      source: `${zh ? '在 NapCat 的 `onebot11.json` 里加入：' : 'Add this to NapCat\'s `onebot11.json`:'}\n\n${fence}json\n{\n  "network": {\n    "websocketServers": [{ "port": 3001, "messagePostFormat": "array", "token": "change-me" }]\n  }\n}\n${fence}`,
    },
    {
      id: 'card',
      source: `${fence}mushin-card\n${JSON.stringify({
        title: zh ? '测试机器人' : 'Test bot',
        subtitle: 'OneBot · ws://127.0.0.1:3001',
        status: 'ok',
        fields: [{ label: zh ? '状态' : 'Status', value: zh ? '在线' : 'online' }, { label: 'QQ', value: '123456789' }, { label: zh ? '插件' : 'Plugins', value: 2 }],
        actions: [{ label: zh ? '打开' : 'Open', path: '/bots' }, { label: zh ? '日志' : 'Logs', path: '/logs' }],
      }, null, 2)}\n${fence}`,
    },
    {
      id: 'steps',
      source: `${fence}mushin-steps\n${JSON.stringify(zh
        ? [{ text: '连接 DeepSeek 提供商', done: true }, { text: '创建机器人并连接 NapCat', done: true }, { text: '开启大模型对话' }, { text: '在群里 @ 机器人试试' }]
        : [{ text: 'Connect a DeepSeek provider', done: true }, { text: 'Create a bot and connect NapCat', done: true }, { text: 'Turn on LLM chat' }, { text: 'Mention the bot in a group' }], null, 2)}\n${fence}`,
    },
    {
      id: 'mermaid',
      source: `${fence}mermaid\nflowchart TD\n  QQ[QQ] --> NapCat\n  NapCat -->|WebSocket| Bot[${zh ? '机器人' : 'Bot'}]\n  Bot --> Flow[${zh ? '流程' : 'Flow'}]\n  Flow --> LLM[${zh ? '大模型' : 'LLM'}]\n${fence}`,
    },
  ]
})

/** Shows an example in the dock as an Agent reply, without calling the model. */
function tryInDock(source: string) {
  agent.newChat()
  agent.items.push({ kind: 'user', text: t('agentPage.styles.demoQuestion') })
  agent.items.push({ kind: 'assistant', text: source })
  agent.open = true
}

async function tryAsk() {
  agent.newChat()
  agent.open = true
  const answer = await agent.ask({
    question: t('agentPage.styles.askQuestion'),
    options: [
      { label: 'DeepSeek', description: t('agentPage.styles.askDeepSeek') },
      { label: 'Ollama', description: t('agentPage.styles.askOllama') },
      { label: 'OpenAI' },
    ],
    recommended: 0,
    allowOther: true,
  }) as { label?: string; other?: string; cancelled?: boolean }
  if (!answer.cancelled) message.info(t('agentPage.styles.askAnswer', { answer: answer.label ?? answer.other }))
}
</script>

<template>
  <div class="styles">
    <p class="hint">{{ t('agentPage.styles.lead') }}</p>
    <NCard v-for="example in examples" :key="example.id" size="small" :title="t(`agentPage.styles.kind.${example.id}`)">
      <template #header-extra>
        <NButton size="small" secondary @click="tryInDock(example.source)">{{ t('agentPage.styles.try') }}</NButton>
      </template>
      <NTabs type="segment" size="small" default-value="preview">
        <NTabPane name="preview" :tab="t('agentPage.styles.preview')">
          <div class="preview"><AgentMessage :text="example.source" /></div>
        </NTabPane>
        <NTabPane name="source" :tab="t('agentPage.styles.source')">
          <pre class="mono source">{{ example.source }}</pre>
        </NTabPane>
      </NTabs>
    </NCard>
    <NCard size="small" :title="t('agentPage.styles.kind.ask')">
      <template #header-extra>
        <NButton size="small" secondary @click="tryAsk">{{ t('agentPage.styles.try') }}</NButton>
      </template>
      <p class="hint small">{{ t('agentPage.styles.askLead') }}</p>
    </NCard>
  </div>
</template>

<style scoped>
.styles {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 820px;
}

.hint {
  opacity: 0.65;
  margin: 0;
}

.small {
  font-size: 12px;
}

.source {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.08);
  font-size: 12.5px;
  white-space: pre-wrap;
  word-break: break-word;
}

.preview {
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.08);
  font-size: 14px;
  line-height: 1.6;
}
</style>
