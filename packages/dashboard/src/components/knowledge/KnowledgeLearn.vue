<script setup lang="ts">
import { CheckmarkOutline, CloseOutline } from '@vicons/ionicons5'
import {
  NAlert, NButton, NCard, NDynamicTags, NEmpty, NForm, NFormItem, NGrid, NGridItem, NIcon, NInput, NInputNumber, NRadioButton, NRadioGroup, NSelect,
  NSpace, NSwitch, NTag, useMessage,
} from 'naive-ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { call, on } from '../../api'
import { useDataStore } from '../../stores/data'
import type { KnowledgeCandidate, KnowledgeLearn, KnowledgeSummary } from '../../types'
import { clone, formatTime } from '../../utils'

const props = defineProps<{ base: KnowledgeSummary }>()
const { t } = useI18n()
const message = useMessage()
const data = useDataStore()

// ---- settings ----

const learn = ref<KnowledgeLearn>(clone(props.base.learn))
watch(() => props.base.learn, (value) => {
  learn.value = clone(value)
}, { deep: true })
const saving = ref(false)
const providerOptions = computed(() => [{ value: '', label: t('knowledge.learn.botProvider') }, ...data.providers.map((provider) => ({ value: provider.id, label: provider.name }))])

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
    <NAlert v-if="!base.bots.length" type="info">{{ t('knowledge.learn.noBots') }}</NAlert>

    <NCard size="small" :title="t('knowledge.learn.settings')">
      <NForm label-placement="top">
        <NGrid cols="1 700:3" responsive="self" :x-gap="16">
          <NGridItem>
            <NFormItem :label="t('knowledge.learn.enabled')" :feedback="t('knowledge.learn.enabledHint')">
              <NSwitch v-model:value="learn.enabled" :disabled="!base.bots.length" />
            </NFormItem>
          </NGridItem>
          <NGridItem>
            <NFormItem :label="t('knowledge.learn.every')" :feedback="t('knowledge.learn.everyHint')">
              <NInputNumber v-model:value="learn.every" :min="10" :max="500" style="width: 100%" />
            </NFormItem>
          </NGridItem>
          <NGridItem>
            <NFormItem :label="t('knowledge.learn.dailyLimit')" :feedback="t('knowledge.learn.dailyLimitHint')">
              <NInputNumber v-model:value="learn.dailyLimit" :min="1" :max="500" style="width: 100%" />
            </NFormItem>
          </NGridItem>
        </NGrid>
        <NFormItem :label="t('knowledge.learn.channels')" :feedback="t('knowledge.learn.channelsHint')">
          <NDynamicTags v-model:value="learn.channels" />
        </NFormItem>
        <NGrid cols="1 700:3" responsive="self" :x-gap="16">
          <NGridItem>
            <NFormItem :label="t('knowledge.learn.autoAccept')" :feedback="t('knowledge.learn.autoAcceptHint')">
              <NSwitch v-model:value="learn.autoAccept" />
            </NFormItem>
          </NGridItem>
          <NGridItem>
            <NFormItem :label="t('knowledge.learn.provider')">
              <NSelect v-model:value="learn.provider" :options="providerOptions" />
            </NFormItem>
          </NGridItem>
          <NGridItem>
            <NFormItem :label="t('knowledge.learn.model')">
              <NInput v-model:value="learn.model" :placeholder="t('knowledge.learn.providerDefault')" clearable />
            </NFormItem>
          </NGridItem>
        </NGrid>
      </NForm>
      <NSpace justify="end">
        <NButton type="primary" :loading="saving" @click="save">{{ t('common.save') }}</NButton>
      </NSpace>
    </NCard>

    <NCard v-if="base.bots.length" size="small" :title="t('knowledge.learn.now')">
      <div class="now">
        <NSelect v-model:value="now.bot" :options="botOptions" class="bot" />
        <NInput v-model:value="now.chat" placeholder="group:123456" class="chat" @keyup.enter="learnNow" />
        <NButton :loading="learning" :disabled="!now.bot || !now.chat.trim()" @click="learnNow">{{ t('knowledge.learn.run') }}</NButton>
      </div>
      <p class="muted small">{{ t('knowledge.learn.nowHint') }}</p>
    </NCard>

    <NCard size="small" :title="t('knowledge.learn.review')">
      <template #header-extra>
        <NRadioGroup v-model:value="status" size="small">
          <NRadioButton value="pending">{{ t('knowledge.learn.status.pending') }}</NRadioButton>
          <NRadioButton value="accepted">{{ t('knowledge.learn.status.accepted') }}</NRadioButton>
          <NRadioButton value="rejected">{{ t('knowledge.learn.status.rejected') }}</NRadioButton>
        </NRadioGroup>
      </template>
      <NEmpty v-if="!candidates.length" :description="t('knowledge.learn.none')" />
      <div v-for="item in candidates" :key="item.id" class="candidate">
        <div class="muted small">
          {{ botName(item.bot) }} · <span class="mono">{{ item.channel }}</span> · {{ formatTime(item.createdAt) }}
          <NTag v-if="item.status !== 'pending'" size="tiny" :bordered="false" :type="item.status === 'accepted' ? 'success' : 'default'">{{ t(`knowledge.learn.status.${item.status}`) }}</NTag>
        </div>
        <template v-if="item.status === 'pending' && edits[item.id]">
          <NInput v-model:value="edits[item.id].question" :placeholder="t('knowledge.learn.question')" />
          <NInput v-model:value="edits[item.id].answer" type="textarea" :autosize="{ minRows: 2, maxRows: 8 }" :placeholder="t('knowledge.learn.answer')" />
          <NSpace justify="end">
            <NButton size="small" :disabled="busy === item.id" @click="reject(item)">
              <template #icon><NIcon><CloseOutline /></NIcon></template>
              {{ t('knowledge.learn.reject') }}
            </NButton>
            <NButton size="small" type="primary" :loading="busy === item.id" @click="accept(item)">
              <template #icon><NIcon><CheckmarkOutline /></NIcon></template>
              {{ t('knowledge.learn.accept') }}
            </NButton>
          </NSpace>
        </template>
        <template v-else>
          <strong>{{ item.question }}</strong>
          <div class="answer">{{ item.answer }}</div>
        </template>
      </div>
    </NCard>
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
