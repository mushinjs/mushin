<script setup lang="ts">
/**
 * Reply text with message parts: buttons add an @mention, a picture or a face as `[at:…]`,
 * `[image:…]` and `[face:…]`, and a bubble shows the message as the chat will show it, with the
 * sample's values filled in where they are known.
 */
import { AtOutline, HappyOutline, ImageOutline } from '@vicons/ionicons5'
import { NButton, NIcon, NInput, NPopover } from 'naive-ui'
import { computed, ref } from 'vue'
import VarInput from '../VarInput.vue'
import { useEditor } from './editor'
import { useNodeWiring } from './useNodeWiring'

const props = defineProps<{ label: string; modelValue: string; quote?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const { t, sampleMatch, sampleValue } = useEditor()
const { varGroups } = useNodeWiring()

const text = computed({
  get: () => props.modelValue ?? '',
  set: (value: string) => emit('update:modelValue', value),
})

const insert = (part: string) => (text.value = `${text.value}${part}`)

const atTarget = ref('{{sys.userId}}')
const imageUrl = ref('')
const faceId = ref('')

type Piece = { kind: 'text'; text: string } | { kind: 'at'; who: string } | { kind: 'image'; url: string } | { kind: 'face'; id: string }

const PART = /(?<!\\)\[(at|image|face):([^\]\s]+)\]/g
/** Fills `{user}`, `{message}` and references from the sample where it can; the rest stay as written. */
function fill(value: string) {
  const message = sampleMatch.value?.message
  let out = value
  if (message) out = out.replace(/\{user\}/g, message.user.name ?? message.user.id).replace(/\{message\}/g, message.text)
  return out.replace(/\{\{[^}]+\}\}/g, (ref) => sampleValue(ref) ?? ref)
}

/** The bubble's pieces, split the way the server splits the text into segments. */
const pieces = computed<Piece[]>(() => {
  const source = text.value
  const out: Piece[] = []
  let last = 0
  for (const match of source.matchAll(PART)) {
    if (match.index > last) out.push({ kind: 'text', text: fill(source.slice(last, match.index)) })
    const value = fill(match[2])
    out.push(match[1] === 'at' ? { kind: 'at', who: value } : match[1] === 'image' ? { kind: 'image', url: value } : { kind: 'face', id: value })
    last = match.index + match[0].length
  }
  if (last < source.length) out.push({ kind: 'text', text: fill(source.slice(last)) })
  return out.map((piece) => (piece.kind === 'text' ? { ...piece, text: piece.text.replace(/\\([\\[])/g, '$1') } : piece)).filter((piece) => piece.kind !== 'text' || piece.text)
})

const atName = (who: string) => {
  const user = sampleMatch.value?.message.user
  return user && who === user.id ? user.name ?? who : who
}
const isUrl = (url: string) => /^https?:\/\//.test(url)
</script>

<template>
  <div class="message-editor">
    <div class="field-label">{{ label }}</div>
    <VarInput v-model="text" :groups="varGroups" multiline :placeholder="t('messageEditor.placeholder')" />
    <div class="parts" role="toolbar" :aria-label="t('messageEditor.parts')">
      <NPopover trigger="click" placement="bottom-start">
        <template #trigger>
          <NButton size="tiny" quaternary><template #icon><NIcon><AtOutline /></NIcon></template>{{ t('messageEditor.at') }}</NButton>
        </template>
        <div class="part-form">
          <NInput v-model:value="atTarget" size="small" :placeholder="t('messageEditor.atPlaceholder')" />
          <div class="quick">
            <NButton size="tiny" secondary @click="atTarget = '{{sys.userId}}'">{{ t('messageEditor.atSender') }}</NButton>
            <NButton size="tiny" secondary @click="atTarget = 'all'">{{ t('messageEditor.atAll') }}</NButton>
          </div>
          <NButton size="small" type="primary" :disabled="!atTarget.trim()" @click="insert(`[at:${atTarget.trim()}]`)">{{ t('common.add') }}</NButton>
        </div>
      </NPopover>
      <NPopover trigger="click" placement="bottom-start">
        <template #trigger>
          <NButton size="tiny" quaternary><template #icon><NIcon><ImageOutline /></NIcon></template>{{ t('messageEditor.image') }}</NButton>
        </template>
        <div class="part-form">
          <NInput v-model:value="imageUrl" size="small" :placeholder="t('messageEditor.imagePlaceholder')" />
          <NButton size="small" type="primary" :disabled="!imageUrl.trim() || /\s/.test(imageUrl.trim())" @click="insert(`[image:${imageUrl.trim()}]`); imageUrl = ''">{{ t('common.add') }}</NButton>
        </div>
      </NPopover>
      <NPopover trigger="click" placement="bottom-start">
        <template #trigger>
          <NButton size="tiny" quaternary><template #icon><NIcon><HappyOutline /></NIcon></template>{{ t('messageEditor.face') }}</NButton>
        </template>
        <div class="part-form">
          <NInput v-model:value="faceId" size="small" :placeholder="t('messageEditor.facePlaceholder')" />
          <NButton size="small" type="primary" :disabled="!faceId.trim()" @click="insert(`[face:${faceId.trim()}]`); faceId = ''">{{ t('common.add') }}</NButton>
        </div>
      </NPopover>
    </div>
    <div v-if="pieces.length" class="bubble-row" :aria-label="t('messageEditor.preview')">
      <div class="bubble">
        <div v-if="quote && sampleMatch" class="quoted">{{ sampleMatch.message.user.name ?? sampleMatch.message.user.id }}：{{ sampleMatch.message.text }}</div>
        <div v-else-if="quote" class="quoted muted">{{ t('messageEditor.quoted') }}</div>
        <template v-for="(piece, index) in pieces" :key="index">
          <span v-if="piece.kind === 'text'" class="text">{{ piece.text }}</span>
          <span v-else-if="piece.kind === 'at'" class="at">@{{ piece.who === 'all' ? t('messageEditor.everyone') : atName(piece.who) }}</span>
          <img v-else-if="piece.kind === 'image' && isUrl(piece.url)" :src="piece.url" alt="" class="image" loading="lazy" referrerpolicy="no-referrer">
          <span v-else-if="piece.kind === 'image'" class="chip">[{{ t('messageEditor.image') }}]</span>
          <span v-else class="chip">[{{ t('messageEditor.face') }} {{ piece.id }}]</span>
        </template>
      </div>
      <span class="muted small">{{ sampleMatch ? t('messageEditor.withSample') : t('messageEditor.asWritten') }}</span>
    </div>
  </div>
</template>

<style scoped>
.message-editor {
  margin-bottom: 14px;
}

.field-label {
  font-size: 13px;
  margin-bottom: 6px;
}

.parts {
  display: flex;
  gap: 2px;
  margin: 4px 0 8px;
}

.part-form {
  display: grid;
  gap: 6px;
  width: 240px;
}

.quick {
  display: flex;
  gap: 4px;
}

.bubble-row {
  display: grid;
  gap: 4px;
  justify-items: end;
}

.bubble {
  max-width: 100%;
  padding: 8px 10px;
  border-radius: 12px 12px 4px 12px;
  background: color-mix(in srgb, var(--primary, #18a058) 16%, transparent);
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.quoted {
  font-size: 12px;
  padding: 2px 6px;
  margin-bottom: 4px;
  border-left: 2px solid rgba(127, 127, 127, 0.5);
  opacity: 0.8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.at {
  color: var(--primary, #18a058);
  font-weight: 500;
  margin-right: 2px;
}

.chip {
  font-size: 12px;
  opacity: 0.75;
}

.image {
  display: block;
  max-width: 160px;
  max-height: 120px;
  border-radius: 6px;
  margin: 4px 0;
}
</style>
