<script setup lang="ts">
import { Alert, Button, Card, Empty, Form, FormItem, Input, NumberInput, RadioButton, RadioGroup, Select, Tag, TagsInput, Toggle, useToast } from '@mushinjs/ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call, on } from '../../api'
import { providerOptions as toProviderOptions } from '../../models'
import { useDataStore } from '../../stores/data'
import ModelSelect from '../ModelSelect.vue'
import type { KnowledgeCandidate, KnowledgeLearn, KnowledgeSummary } from '../../types'
import { clone, formatTime } from '../../utils'

const props = defineProps<{ base: KnowledgeSummary }>()
const { t } = useI18n()
const message = useToast()
const data = useDataStore()

// ---- settings ----

const learn = ref<KnowledgeLearn>(clone(props.base.learn))
watch(() => props.base.learn, (value) => {
  learn.value = clone(value)
}, { deep: true })
const saving = ref(false)
const providerOptions = computed(() => [{ value: '', label: t('knowledge.learn.botProvider') }, ...toProviderOptions(data.providers, data.profiles, t)])

async function save() {
  const invalid = learn.value.channels.find((channel) => !/^(group|private):\S+$/.test(channel))
  if (invalid) {
    message.warning(t('knowledge.learn.channelInvalid', { channel: invalid }))
    return
  }
  saving.value = true
  try {
    await call('kb.update', { id: props.base.id, learn: learn.value })
    message.success(t('common.saved'))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

// ---- learning from one chat now ----

const now = ref({ bot: props.base.bots[0] ?? '', chat: '' })
const learning = ref(false)
const botOptions = computed(() => props.base.bots.map((id) => ({ value: id, label: data.bots.find((bot) => bot.id === id)?.name ?? id })))

async function learnNow() {
  if (!/^(group|private):\S+$/.test(now.value.chat.trim())) {
    message.warning(t('knowledge.learn.channelInvalid', { channel: now.value.chat }))
    return
  }
  learning.value = true
  try {
    const result = await call<{ candidates: KnowledgeCandidate[]; skipped?: string }>('kb.learn', { base: props.base.id, bot: now.value.bot, chat: now.value.chat.trim() })
    if (result.skipped) message.info(t('knowledge.learn.skipped', { reason: result.skipped }))
    else message.success(t('knowledge.learn.learned', { count: result.candidates.length }))
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    learning.value = false
  }
}

// ---- review ----

const status = ref<'pending' | 'accepted' | 'rejected'>('pending')
const candidates = ref<KnowledgeCandidate[]>([])
/** Candidate id → the question and answer as edited before accepting. */
const edits = ref<Record<number, { question: string; answer: string }>>({})
const busy = ref<number>()

async function refresh() {
  try {
    candidates.value = await call<KnowledgeCandidate[]>('kb.candidates.list', { base: props.base.id, status: status.value })
    edits.value = Object.fromEntries(candidates.value.map((item) => [item.id, edits.value[item.id] ?? { question: item.question, answer: item.answer }]))
  } catch (error) {
    message.error((error as Error).message)
  }
}
watch([() => props.base.id, status], refresh, { immediate: true })
const offs = [on('knowledge/changed', (event: { base?: string }) => {
  if (!event?.base || event.base === props.base.id) void refresh()
})]
onBeforeUnmount(() => offs.forEach((off) => off()))

async function accept(item: KnowledgeCandidate) {
  busy.value = item.id
  try {
    const edit = edits.value[item.id]
    await call('kb.candidates.accept', {
      id: item.id,
      ...(edit.question !== item.question ? { question: edit.question } : {}),
      ...(edit.answer !== item.answer ? { answer: edit.answer } : {}),
    })
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    busy.value = undefined
  }
}

async function reject(item: KnowledgeCandidate) {
  busy.value = item.id
  try {
    await call('kb.candidates.reject', { id: item.id })
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    busy.value = undefined
  }
}

const botName = (id: string) => data.bots.find((bot) => bot.id === id)?.name ?? id
</script>

<template>
  <div class="learn">
    <p class="muted small">{{ t('knowledge.learn.lead') }}</p>
    <Alert v-if="!base.bots.length" type="info">{{ t('knowledge.learn.noBots') }}</Alert>

    <Card size="small" :title="t('knowledge.learn.settings')">
      <Form>
        <div class="grid gap-x-[16px] gap-y-[18px] grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
          <FormItem :label="t('knowledge.learn.enabled')" :feedback="t('knowledge.learn.enabledHint')">
            <Toggle v-model:value="learn.enabled" :disabled="!base.bots.length" />
          </FormItem>
          <FormItem :label="t('knowledge.learn.every')" :feedback="t('knowledge.learn.everyHint')">
            <NumberInput v-model:value="learn.every" :min="10" :max="500" style="width: 100%" />
          </FormItem>
          <FormItem :label="t('knowledge.learn.dailyLimit')" :feedback="t('knowledge.learn.dailyLimitHint')">
            <NumberInput v-model:value="learn.dailyLimit" :min="1" :max="500" style="width: 100%" />
          </FormItem>
        </div>
        <FormItem :label="t('knowledge.learn.channels')" :feedback="t('knowledge.learn.channelsHint')">
          <TagsInput v-model:value="learn.channels" />
        </FormItem>
        <div class="grid gap-x-[16px] gap-y-[18px] grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
          <FormItem :label="t('knowledge.learn.autoAccept')" :feedback="t('knowledge.learn.autoAcceptHint')">
            <Toggle v-model:value="learn.autoAccept" />
          </FormItem>
          <FormItem :label="t('knowledge.learn.provider')">
            <Select v-model:value="learn.provider" :options="providerOptions" />
          </FormItem>
          <FormItem :label="t('knowledge.learn.model')">
            <ModelSelect :model-value="learn.model || null" :provider="learn.provider" :placeholder="t('knowledge.learn.providerDefault')" @update:model-value="(value) => (learn.model = value ?? '')" />
          </FormItem>
        </div>
      </Form>
      <div class="flex flex-wrap gap-x-3 gap-y-2 items-center justify-end">
        <Button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</Button>
      </div>
    </Card>

    <Card v-if="base.bots.length" size="small" :title="t('knowledge.learn.now')">
      <div class="now">
        <Select v-model:value="now.bot" :options="botOptions" class="bot" />
        <Input v-model:value="now.chat" placeholder="group:123456" class="chat" @keyup.enter="learnNow" />
        <Button :loading="learning" :disabled="!now.bot || !now.chat.trim()" @click="learnNow">{{ t('knowledge.learn.run') }}</Button>
      </div>
      <p class="muted small">{{ t('knowledge.learn.nowHint') }}</p>
    </Card>

    <Card size="small" :title="t('knowledge.learn.review')">
      <template #header-extra>
        <RadioGroup v-model:value="status" size="small">
          <RadioButton value="pending">{{ t('knowledge.learn.status.pending') }}</RadioButton>
          <RadioButton value="accepted">{{ t('knowledge.learn.status.accepted') }}</RadioButton>
          <RadioButton value="rejected">{{ t('knowledge.learn.status.rejected') }}</RadioButton>
        </RadioGroup>
      </template>
      <Empty v-if="!candidates.length" :description="t('knowledge.learn.none')" />
      <div v-for="item in candidates" :key="item.id" class="candidate">
        <div class="muted small">
          {{ botName(item.bot) }} · <span class="mono">{{ item.channel }}</span> · {{ formatTime(item.createdAt) }}
          <Tag v-if="item.status !== 'pending'" size="tiny" :type="item.status === 'accepted' ? 'success' : 'default'">{{ t(`knowledge.learn.status.${item.status}`) }}</Tag>
        </div>
        <template v-if="item.status === 'pending' && edits[item.id]">
          <Input v-model:value="edits[item.id].question" :placeholder="t('knowledge.learn.question')" />
          <Input v-model:value="edits[item.id].answer" type="textarea" :autosize="{ minRows: 2, maxRows: 8 }" :placeholder="t('knowledge.learn.answer')" />
          <div class="flex flex-wrap gap-x-3 gap-y-2 items-center justify-end">
            <Button size="small" :disabled="busy === item.id" icon="i-lucide-x" @click="reject(item)">
              {{ t('knowledge.learn.reject') }}
            </Button>
            <Button size="small" type="primary" :loading="busy === item.id" icon="i-lucide-check" @click="accept(item)">
              {{ t('knowledge.learn.accept') }}
            </Button>
          </div>
        </template>
        <template v-else>
          <strong>{{ item.question }}</strong>
          <div class="answer">{{ item.answer }}</div>
        </template>
      </div>
    </Card>
  </div>
</template>

<style scoped>
.learn {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.small {
  font-size: 12px;
}

.now {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.bot {
  width: 200px;
}

.chat {
  flex: 1;
  min-width: 180px;
}

.candidate {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 0;
  border-top: 1px solid rgba(128, 128, 128, 0.15);
}

.candidate:first-of-type {
  border-top: none;
}

.answer {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
}
</style>
