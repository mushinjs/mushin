<script setup lang="ts">
import { Alert, Avatar, Button, Empty, Form, FormItem, Input, NumberInput, Select, Spin, Tag, TagsInput, useConfirm, useToast } from '@mushinjs/ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave, RouterLink, useRoute, useRouter } from 'vue-router'
import { call, on } from '../api'
import { avatarColor } from '../botAvatar'
import EmptyState from '../components/EmptyState.vue'
import PageHeader from '../components/PageHeader.vue'
import SaveBar from '../components/SaveBar.vue'
import IconAction from '../components/IconAction.vue'
import { imageAsDataUrl, readPersonaFile } from '../personaCards'
import ModelSelect from '../components/ModelSelect.vue'
import { providerOptions as toProviderOptions } from '../models'
import { useDataStore } from '../stores/data'
import type { AppPlugin, BotPersonaSettings, Persona, PersonaDraft } from '../types'
import { clone, downloadJson } from '../utils'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const data = useDataStore()
const message = useToast()
const dialog = useConfirm()

const personas = ref<Persona[]>([])
/** Persona id → names of the bots that use it. */
const usedBy = ref<Record<string, string[]>>({})
const available = ref<boolean>()
const loading = ref(true)

const VARIABLES = ['{bot.name}', '{user.name}', '{user.id}', '{group.id}', '{time}', '{date}', '{weekday}']

async function refresh() {
  try {
    const plugins = await call<AppPlugin[]>('plugins.list')
    available.value = plugins.some((plugin) => plugin.package === '@mushinjs/plugin-personas' && plugin.status === 'active')
    if (!available.value) return
    personas.value = await call<Persona[]>('personas.list')
    reconcile()
    if (!data.loadedBots) await data.refreshBots()
    const uses: Record<string, string[]> = {}
    await Promise.all(data.bots.map(async (bot) => {
      const settings = await call<BotPersonaSettings>('personas.botSettings', { bot: bot.id })
      const ids = new Set([...settings.personas, ...(settings.default ? [settings.default] : []), ...settings.rules.map((rule) => rule.persona)])
      for (const id of ids) (uses[id] ??= []).push(bot.name)
    }))
    usedBy.value = uses
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void refresh()
  if (!data.loadedProviders) data.refreshProviders().catch(() => {})
})
const offs = [on('personas/changed', refresh), on('manager/changed', refresh)]
onBeforeUnmount(() => offs.forEach((off) => off()))

// ---- the list on the left, the selected persona on the right ----
// The selection lives in the URL (?persona=<id>, or "new"), so a persona can be linked to.

const NEW = 'new'
const blank = (): PersonaDraft => ({ name: '', prompt: '', description: '', examples: [], avoid: '', tags: [] })
const selectedId = ref<string | undefined>(typeof route.query.persona === 'string' ? route.query.persona : undefined)
const draft = ref<PersonaDraft>(blank())
/** The draft as it was loaded, to tell whether anything changed. */
const original = ref('')
const saving = ref(false)
const query = ref('')

const selected = computed(() => personas.value.find((persona) => persona.id === selectedId.value))
const creating = computed(() => selectedId.value === NEW)
const dirty = computed(() => !!selectedId.value && JSON.stringify(payload(draft.value)) !== original.value)

const shown = computed(() => {
  const text = query.value.trim().toLowerCase()
  if (!text) return personas.value
  return personas.value.filter((persona) => [persona.name, persona.description, ...persona.tags].some((value) => value?.toLowerCase().includes(text)))
})

function load(id: string | undefined) {
  selectedId.value = id
  const persona = personas.value.find((item) => item.id === id)
  if (persona) {
    const { id: _id, createdAt: _created, updatedAt: _updated, ...fields } = clone(persona)
    draft.value = { ...blank(), ...fields }
  } else {
    draft.value = blank()
  }
  original.value = JSON.stringify(payload(draft.value))
}

/** Asks before unsaved changes are thrown away; resolves true when it is fine to go on. */
function confirmDiscard() {
  if (!dirty.value) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    dialog.warning({
      title: t('personas.unsavedTitle'),
      content: t('personas.unsavedHint'),
      positiveText: t('personas.discard'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
      onMaskClick: () => resolve(false),
    })
  })
}

async function select(id: string | undefined) {
  if (id === selectedId.value) return
  if (!(await confirmDiscard())) return
  load(id)
}

const openCreate = () => select(NEW)

/** After the list changes: keep the selection if it still exists, else fall back to the first persona on a wide page. */
function reconcile() {
  const id = selectedId.value
  if (id === NEW) return
  if (id && personas.value.some((persona) => persona.id === id)) {
    // Reload unless the user is in the middle of an edit.
    if (!dirty.value) load(id)
    return
  }
  load(narrow.value ? undefined : personas.value[0]?.id)
}

watch(selectedId, (id) => {
  const current = typeof route.query.persona === 'string' ? route.query.persona : undefined
  if (id !== current) router.replace({ query: { ...route.query, persona: id } })
})

onBeforeRouteLeave(() => confirmDiscard())

function onBeforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) event.preventDefault()
}
window.addEventListener('beforeunload', onBeforeUnload)
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))

// The list and the editor sit side by side; on a narrow page one shows at a time.
const root = ref<HTMLElement>()
const width = ref(1200)
const narrow = computed(() => width.value < 640)
let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(([entry]) => (width.value = entry.contentRect.width))
  if (root.value) observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())

function insertVariable(variable: string) {
  draft.value.prompt += variable
}

const providerOptions = computed(() => toProviderOptions(data.providers, data.profiles, t))

/** Leaves out empty optional fields, so they fall back to the bot's settings. */
function payload(value: PersonaDraft) {
  return {
    name: value.name.trim(),
    prompt: value.prompt,
    examples: value.examples.filter((example) => example.user.trim() && example.assistant.trim()),
    tags: value.tags,
    ...(value.avatar ? { avatar: value.avatar } : {}),
    ...(value.description?.trim() ? { description: value.description.trim() } : {}),
    ...(value.avoid?.trim() ? { avoid: value.avoid.trim() } : {}),
    ...(value.provider ? { provider: value.provider } : {}),
    ...(value.model?.trim() ? { model: value.model.trim() } : {}),
    ...(value.temperature !== undefined && value.temperature !== null ? { temperature: value.temperature } : {}),
  }
}

async function save() {
  if (!draft.value.name.trim() || !draft.value.prompt.trim()) {
    message.warning(t('personas.required'))
    return
  }
  saving.value = true
  try {
    const body = payload(draft.value)
    let id = selectedId.value
    if (id && id !== NEW) {
      // Cleared optional fields are sent empty so the old value goes away.
      await call('personas.update', { id, avatar: '', description: '', avoid: '', provider: '', model: '', ...body })
    } else {
      id = (await call<Persona>('personas.create', body)).id
    }
    // Marked saved before the list reloads, so the reload replaces the draft.
    original.value = JSON.stringify(body)
    selectedId.value = id
    message.success(t('common.saved'))
    await refresh()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

async function duplicate(persona: Persona) {
  if (!(await confirmDiscard())) return
  try {
    const { id: _id, createdAt: _created, updatedAt: _updated, ...fields } = persona
    const result = await call<{ created: Persona[] }>('personas.import', { data: { ...fields, name: persona.name } })
    await refresh()
    if (result.created[0]) load(result.created[0].id)
  } catch (error) {
    message.error((error as Error).message)
  }
}

function remove(persona: Persona) {
  dialog.warning({
    title: t('common.confirmDelete', { name: persona.name }),
    content: usedBy.value[persona.id]?.length ? t('personas.deleteUsed', { bots: usedBy.value[persona.id].join('、') }) : t('personas.deleteHint'),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await call('personas.delete', { id: persona.id })
      message.success(t('common.deleted'))
      // The deleted persona's draft is gone with it.
      original.value = JSON.stringify(payload(draft.value))
      await refresh()
    },
  })
}

// ---- avatar, import and export ----

const avatarInput = ref<HTMLInputElement>()
async function pickAvatar(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (!file) return
  if (file.size > 256 * 1024) {
    message.warning(t('personas.avatarTooLarge'))
    return
  }
  draft.value.avatar = await imageAsDataUrl(file)
}

const importInput = ref<HTMLInputElement>()
async function importFiles(event: Event) {
  const files = [...(event.target as HTMLInputElement).files ?? []]
  ;(event.target as HTMLInputElement).value = ''
  let created = 0
  for (const file of files) {
    try {
      const result = await call<{ created: Persona[]; failed: { name: string; error: string }[] }>('personas.import', { data: await readPersonaFile(file) })
      created += result.created.length
      for (const failure of result.failed) message.error(`${failure.name}: ${failure.error}`)
    } catch (error) {
      message.error(`${file.name}: ${(error as Error).message}`)
    }
  }
  if (created) message.success(t('personas.imported', { count: created }))
  await refresh()
}

async function exportPersonas(ids?: string[], name = 'personas') {
  try {
    downloadJson(`${name}.json`, await call('personas.export', { ids }))
  } catch (error) {
    message.error((error as Error).message)
  }
}

const initial = (name: string) => [...name.trim()][0] ?? '?'
</script>

<template>
  <div ref="root" class="page" :class="{ narrow }">
    <PageHeader :title="t('nav.personas')" :lead="t('personas.lead')">
      <div v-if="available" class="header-actions">
        <Button icon="i-lucide-cloud-upload" @click="importInput?.click()">
          {{ t('personas.import') }}
        </Button>
        <Button :disabled="!personas.length" icon="i-lucide-cloud-download" @click="exportPersonas()">
          {{ t('personas.exportAll') }}
        </Button>
        <Button type="primary" data-agent-target="personas.add" icon="i-lucide-plus" @click="openCreate">
          {{ t('personas.add') }}
        </Button>
      </div>
      <input ref="importInput" type="file" accept=".json,.png,application/json,image/png" multiple hidden @change="importFiles">
    </PageHeader>

    <Spin :show="loading">
      <Alert v-if="available === false" type="warning" :title="t('personas.unavailable')">
        {{ t('personas.unavailableHint') }}
        <RouterLink to="/plugins?highlight=@mushinjs/plugin-personas">{{ t('permissions.openPlugins') }}</RouterLink>
      </Alert>
      <EmptyState v-else-if="!personas.length && !creating && !loading" icon="i-lucide-circle-user" :title="t('personas.emptyTitle')" :hint="t('personas.emptyHint')">
        <Button type="primary" @click="openCreate">{{ t('personas.add') }}</Button>
        <Button @click="importInput?.click()">{{ t('personas.import') }}</Button>
      </EmptyState>

      <div v-else-if="available" class="split">
        <!-- The list -->
        <aside v-if="!narrow || !selectedId" class="list" :aria-label="t('nav.personas')">
          <Input v-if="personas.length > 4" v-model:value="query" clearable size="small" :placeholder="t('personas.search')" class="list-search">
            <template #prefix><span class="i-lucide-search" /></template>
          </Input>
          <div class="items" role="listbox" :aria-label="t('nav.personas')">
            <button
              v-for="persona in shown"
              :key="persona.id"
              type="button"
              role="option"
              class="item"
              :class="{ active: persona.id === selectedId }"
              :aria-selected="persona.id === selectedId"
              @click="select(persona.id)"
            >
              <Avatar :size="36" :src="persona.avatar || undefined" class="item-avatar" :color="avatarColor(persona.id)">{{ initial(persona.name) }}</Avatar>
              <span class="item-text">
                <strong>
                  {{ persona.id === selectedId && dirty ? draft.name || persona.name : persona.name }}
                  <span v-if="persona.id === selectedId && dirty" class="unsaved-dot" :title="t('personas.unsavedTitle')" />
                </strong>
                <span class="item-sub">{{ persona.description || persona.prompt }}</span>
              </span>
              <span class="item-use" :class="{ on: usedBy[persona.id]?.length }" :title="usedBy[persona.id]?.length ? t('personas.usedBy', { bots: usedBy[persona.id].join('、') }) : t('personas.unused')">
                {{ usedBy[persona.id]?.length ?? 0 }}
              </span>
            </button>
            <button v-if="creating" type="button" class="item active" aria-selected="true">
              <Avatar :size="36" :src="draft.avatar || undefined" class="item-avatar" :color="avatarColor(NEW)">{{ initial(draft.name || '?') }}</Avatar>
              <span class="item-text">
                <strong>{{ draft.name || t('personas.untitled') }}</strong>
                <span class="item-sub">{{ t('personas.notSaved') }}</span>
              </span>
            </button>
            <p v-if="!shown.length && !creating" class="no-match">{{ t('personas.noMatch') }}</p>
          </div>
        </aside>

        <!-- The editor -->
        <section v-if="selectedId && (selected || creating)" class="detail">
          <header class="detail-head">
            <Button v-if="narrow" quaternary circle :aria-label="t('common.back')" icon="i-lucide-arrow-left" @click="select(undefined)" />
            <div class="avatar-edit">
              <Avatar :size="56" :src="draft.avatar || undefined" :color="avatarColor(selectedId ?? '')">{{ initial(draft.name || '?') }}</Avatar>
              <button type="button" class="avatar-change" @click="avatarInput?.click()">{{ draft.avatar ? t('personas.changeAvatar') : t('personas.uploadAvatar') }}</button>
              <button v-if="draft.avatar" type="button" class="avatar-change" @click="draft.avatar = ''">{{ t('common.remove') }}</button>
              <input ref="avatarInput" type="file" accept="image/*" hidden @change="pickAvatar">
            </div>
            <div class="identity">
              <Input v-model:value="draft.name" :maxlength="60" :placeholder="t('common.name')" class="name-input" :aria-label="t('common.name')" />
              <span class="used">
                {{ creating ? t('personas.notSaved') : usedBy[selectedId]?.length ? t('personas.usedBy', { bots: usedBy[selectedId].join('、') }) : t('personas.unused') }}
              </span>
            </div>
            <div v-if="selected" class="detail-actions">
              <IconAction icon="i-lucide-copy" :label="t('personas.duplicate')" @click="duplicate(selected)" />
              <IconAction icon="i-lucide-download" :label="t('personas.export')" @click="exportPersonas([selected.id], selected.name)" />
              <IconAction icon="i-lucide-trash-2" :label="t('common.delete')" type="error" @click="remove(selected)" />
            </div>
          </header>

          <Form as="form" class="form" @submit="save">
            <section class="block">
              <FormItem :label="t('personas.description')" :feedback="t('personas.descriptionHint')">
                <Input v-model:value="draft.description" :maxlength="500" />
              </FormItem>
              <FormItem :label="t('personas.prompt')" required>
                <div class="stack">
                  <Input v-model:value="draft.prompt" type="textarea" :autosize="{ minRows: 8, maxRows: 24 }" :placeholder="t('personas.promptPlaceholder')" />
                  <div class="variables">
                    <span class="muted">{{ t('personas.variables') }}</span>
                    <Tag v-for="variable in VARIABLES" :key="variable" size="small" class="mono clickable" @click="insertVariable(variable)">{{ variable }}</Tag>
                  </div>
                </div>
              </FormItem>
            </section>

            <section class="block">
              <h3 class="block-title">{{ t('personas.examples') }} <span class="count">{{ draft.examples.length || '' }}</span></h3>
              <p class="block-hint">{{ t('personas.examplesHint') }}</p>
              <div class="stack">
                <div v-for="(example, index) in draft.examples" :key="index" class="example">
                  <Input v-model:value="example.user" :placeholder="t('personas.exampleUser')" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" />
                  <Input v-model:value="example.assistant" :placeholder="t('personas.exampleAssistant')" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" />
                  <IconAction icon="i-lucide-trash-2" :label="t('common.remove')" type="error" @click="draft.examples.splice(index, 1)" />
                </div>
                <Button size="small" dashed class="add-example" icon="i-lucide-plus" @click="draft.examples.push({ user: '', assistant: '' })">
                  {{ t('personas.addExample') }}
                </Button>
              </div>
            </section>

            <section class="block">
              <FormItem :label="t('personas.avoid')" :feedback="t('personas.avoidHint')">
                <Input v-model:value="draft.avoid" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" />
              </FormItem>
            </section>

            <section class="block">
              <h3 class="block-title">{{ t('personas.advanced') }}</h3>
              <div class="advanced-grid">
                <FormItem :label="t('personas.provider')">
                  <Select v-model:value="draft.provider" :options="providerOptions" clearable :placeholder="t('personas.botDefault')" />
                </FormItem>
                <FormItem :label="t('personas.model')">
                  <ModelSelect :model-value="draft.model || null" :provider="draft.provider" :placeholder="t('personas.botDefault')" @update:model-value="(value) => (draft.model = value ?? '')" />
                </FormItem>
                <FormItem :label="t('personas.temperature')">
                  <NumberInput v-model:value="draft.temperature" :min="0" :max="2" :step="0.1" clearable :placeholder="t('personas.botDefault')" style="width: 100%" />
                </FormItem>
              </div>
              <FormItem :label="t('personas.tags')">
                <TagsInput v-model:value="draft.tags" />
              </FormItem>
            </section>
          </Form>

          <SaveBar
            :show="dirty"
            :saving="saving"
            :text="creating ? t('personas.newUnsaved') : t('personas.unsavedTitle')"
            :discard-text="creating ? t('common.cancel') : t('personas.discard')"
            :save-text="creating ? t('common.create') : t('common.save')"
            @discard="creating ? (original = JSON.stringify(payload(draft)), select(personas[0]?.id)) : load(selectedId)"
            @save="save"
          />
        </section>

        <div v-else-if="!narrow" class="detail detail-empty">
          <Empty :description="t('personas.pick')" />
        </div>
      </div>
    </Spin>
  </div>
</template>

<style scoped>
/* ---- the two columns ---- */

.split {
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}

.narrow .split {
  grid-template-columns: minmax(0, 1fr);
}

.list {
  position: sticky;
  top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: calc(100vh - 140px);
  min-height: 0;
}

.narrow .list {
  position: static;
  max-height: none;
}

.items {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
}

.item {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.item:hover {
  background: var(--row-hover);
}

.item.active {
  background: var(--primary-soft);
}

.item:focus-visible,
.avatar-change:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}

.item-avatar {
  flex: none;
}

.item-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.item-text strong {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.active .item-text strong {
  color: var(--primary);
}

.item-sub {
  overflow: hidden;
  font-size: 12.5px;
  color: var(--fg3);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.unsaved-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  background: var(--warn);
}

/* How many bots use a persona: green when any do. */
.item-use {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--s2);
  color: var(--fg3);
  font-size: 11.5px;
  line-height: 20px;
  text-align: center;
}

.item-use.on {
  background: var(--ok-soft);
  color: var(--ok);
}

.no-match {
  margin: 0;
  padding: 16px 8px;
  font-size: 13px;
  color: var(--fg3);
  text-align: center;
}

/* ---- the editor ---- */

.detail {
  min-width: 0;
}

.detail-empty {
  display: grid;
  place-items: center;
  min-height: 320px;
  border: 1.5px dashed var(--line);
  border-radius: var(--radius);
}

.detail-head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 18px 18px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius) var(--radius) 0 0;
  background: var(--s1);
}

.avatar-edit {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  flex: none;
}

.avatar-change {
  padding: 0;
  border: 0;
  background: none;
  color: var(--primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.avatar-edit .avatar-change:first-of-type {
  margin-top: 6px;
}

.identity {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
}

.header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.detail-actions {
  display: flex;
  gap: 2px;
}

/* Three across when there is room, otherwise as many as fit. */
.advanced-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 16px 12px;
}

.name-input :deep(input) {
  font-size: 17px;
  font-weight: 600;
}

.used {
  font-size: 12.5px;
  color: var(--fg3);
}

.form {
  gap: 0;
  border: 1px solid var(--line);
  border-top: 0;
  border-radius: 0 0 var(--radius) var(--radius);
  background: var(--s1);
}

.block {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 18px 18px;
}

.block + .block {
  border-top: 1px solid var(--line);
}

.block-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.block-title .count {
  font-size: 12px;
  font-weight: 400;
  color: var(--fg3);
}

.block-hint {
  margin: 0 0 10px;
  font-size: 12.5px;
  color: var(--fg3);
}

.stack {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.block > .stack {
  margin-bottom: 16px;
}

.add-example {
  align-self: flex-start;
}

.variables {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.muted {
  color: var(--fg3);
}

.clickable {
  cursor: pointer;
}

.example {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 8px;
  align-items: start;
}

.narrow .example {
  grid-template-columns: 1fr;
}

.narrow .detail-head {
  flex-wrap: wrap;
}

.narrow .detail-head {
  align-items: center;
}

.narrow .detail-actions {
  margin-left: auto;
}

/* On a phone the name takes its own row under the avatar. */
.narrow .identity {
  order: 5;
  flex-basis: 100%;
  padding-top: 0;
}
</style>
