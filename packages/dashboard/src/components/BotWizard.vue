<script setup lang="ts">
/**
 * Adding a bot, one step at a time: platform, connection (skippable), name, plugins, masters and
 * admins, then a summary. Every step has a default, so "Next" all the way through makes a bot.
 *
 * The bot is created as soon as it connects (a QR scan connects right away), so its account name,
 * picture and invite link can be shown while the steps go on. Skipping the connection creates it
 * stopped at the end, with whatever was filled in.
 */
import { Alert, Button, Checkbox, Modal, RadioGroup, Spin, TagsInput, useConfirm, useToast } from '@mushinjs/ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { call } from '../api'
import { adapterMode, guideKey, hiddenFields, isInbound } from '../adapters'
import { avatarColor, initial } from '../botAvatar'
import { useDataStore } from '../stores/data'
import type { AppPlugin, Bot, CatalogEntry, Contact } from '../types'
import { localize } from '../utils'
import AdapterIcon from './AdapterIcon.vue'
import AdapterLinks from './AdapterLinks.vue'
import QrCode from './QrCode.vue'
import QrSetup from './QrSetup.vue'
import SchemaForm from './SchemaForm.vue'

const show = defineModel<boolean>('show', { required: true })

const { t, te, locale } = useI18n()
const router = useRouter()
const data = useDataStore()
const message = useToast()
const dialog = useConfirm()

type Step = 'adapter' | 'connect' | 'name' | 'plugins' | 'roles' | 'done'
const STEPS: Step[] = ['adapter', 'connect', 'name', 'plugins', 'roles']
const DEFAULT_PLUGINS = ['@mushinjs/bot-plugin-llm-chat']

const step = ref<Step>('adapter')
const adapterType = ref('')
const config = ref<Record<string, any>>({})
const method = ref<'scan' | 'manual'>('scan')
/** The bot, once it was created by connecting (or at the end). */
const botId = ref<string>()
const connecting = ref(false)
const name = ref('')
const nameTouched = ref(false)
const plugins = ref<string[]>([])
const catalog = ref<CatalogEntry[]>([])
const masters = ref<string[]>([])
const admins = ref<string[]>([])
const permissions = ref(false)
const contacts = ref<Contact[]>([])
const saving = ref(false)
const serverUrl = ref('')

const adapter = computed(() => data.adapters.find((item) => item.id === adapterType.value))
const adapterName = computed(() => localize(adapter.value?.displayName, locale.value) || adapterType.value)
const bot = computed(() => data.bots.find((item) => item.id === botId.value))
const online = computed(() => bot.value?.status === 'online')

watch(show, async (visible) => {
  if (!visible) return leave()
  step.value = 'adapter'
  adapterType.value = data.adapters[0]?.id ?? ''
  config.value = {}
  method.value = 'scan'
  botId.value = undefined
  name.value = ''
  nameTouched.value = false
  masters.value = []
  admins.value = []
  contacts.value = []
  const [entries, installed, info] = await Promise.all([
    call<CatalogEntry[]>('plugins.catalog', { kind: 'bot' }).catch(() => [] as CatalogEntry[]),
    call<AppPlugin[]>('plugins.list').catch(() => [] as AppPlugin[]),
    call<{ baseUrl: string }>('system.info').catch(() => undefined),
  ])
  catalog.value = entries
  plugins.value = DEFAULT_PLUGINS.filter((item) => entries.some((entry) => entry.package === item))
  permissions.value = installed.some((plugin) => plugin.package === '@mushinjs/plugin-permissions' && plugin.status === 'active')
  serverUrl.value = info?.baseUrl ?? ''
})

// ---- steps ----

const index = computed(() => STEPS.indexOf(step.value))

function go(next: Step) {
  if (next === 'name' && !nameTouched.value) name.value = defaultName()
  if (next === 'roles') loadContacts()
  step.value = next
  // An adapter with nothing to fill in (the sandbox) connects as soon as its step opens.
  if (next === 'connect' && !botId.value && !needsSetup.value) connect()
}

const back = () => go(STEPS[index.value - 1])
const forward = () => go(STEPS[index.value + 1])

/** The account's own name when it connected, else "<platform> Bot". */
const defaultName = () => bot.value?.selfName || t('wizard.defaultName', { adapter: adapterName.value })

// ---- adapter ----

async function pick(id: string) {
  if (id === adapterType.value) return
  // A bot made for the other platform goes; this one starts from its own defaults.
  if (botId.value) await discard()
  adapterType.value = id
  config.value = {}
  method.value = 'scan'
}

// ---- connection ----

const fields = computed(() => Object.keys(adapter.value?.configSchema.properties ?? {}).filter((key) => !hidden.value.includes(key)))
const needsSetup = computed(() => !!adapter.value?.qrSetup || fields.value.length > 0)
const mode = computed(() => adapterMode(adapter.value, config.value))
const hidden = computed(() => hiddenFields(adapter.value, config.value))
const guide = computed(() => (te(guideKey(adapterType.value, mode.value)) ? t(guideKey(adapterType.value, mode.value)) : ''))
const scanning = computed(() => !!adapter.value?.qrSetup && method.value === 'scan' && !botId.value)
const methodOptions = computed(() => [{ label: t('bots.qr.methodScan'), value: 'scan' }, { label: t('bots.qr.methodManual'), value: 'manual' }])
// Where the platform reaches Mushin, for modes where it connects to us.
const inboundUrl = computed(() => {
  if (!botId.value || !isInbound(mode.value)) return ''
  const url = `${serverUrl.value || location.origin}${config.value.path || `/${adapterType.value}/${botId.value}`}`
  return mode.value === 'reverse' ? url.replace(/^http/, 'ws') : url
})
const inviteHint = computed(() => (te(`bots.invite.${adapterType.value}`) ? t(`bots.invite.${adapterType.value}`) : t('bots.invite.default')))

/** Creates the bot and starts it, or saves the new connection settings of the one already made. */
async function connect() {
  connecting.value = true
  try {
    const adapterInput = { type: adapterType.value, config: config.value }
    if (!botId.value) {
      const created = await call<Bot>('bots.create', { name: defaultName(), adapter: adapterInput, plugins: [] })
      botId.value = created.id
    } else {
      await call('bots.update', { id: botId.value, adapter: adapterInput })
      if (!bot.value?.enabled) await call('bots.start', { id: botId.value })
    }
    await data.refreshBots()
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    connecting.value = false
  }
}

/** A QR scan fills the config in; connect with it right away. */
function scanned(result: Record<string, any>) {
  config.value = { ...config.value, ...result }
  method.value = 'manual'
  connect()
}

// ---- masters and admins ----

/** Friends of the account, to pick a master from instead of typing an id. */
async function loadContacts() {
  if (!permissions.value || !online.value || adapterType.value === 'sandbox') return
  const list = await call<Contact[]>('bots.contacts', { id: botId.value }).catch(() => [] as Contact[])
  contacts.value = list.filter((item) => item.type === 'private').slice(0, 12)
}

const addMaster = (id: string) => (masters.value = masters.value.includes(id) ? masters.value : [...masters.value, id])

// ---- finish ----

async function finish() {
  saving.value = true
  try {
    let id = botId.value
    const label = name.value.trim() || defaultName()
    if (!id) {
      // Not connected: saved stopped, its connection set up later on its Connection page.
      const created = await call<Bot>('bots.create', {
        name: label,
        adapter: { type: adapterType.value, config: config.value },
        plugins: plugins.value.map((item) => ({ package: item })),
        enabled: false,
      })
      id = botId.value = created.id
    } else {
      if (label !== bot.value?.name) await call('bots.update', { id, name: label })
      for (const item of plugins.value) await call('bots.plugins.enable', { id, package: item })
    }
    const valid = (value: string) => /^\S+$/.test(value)
    if (permissions.value && (masters.value.length || admins.value.length)) {
      await call('permissions.update', { bot: id, masters: masters.value.filter(valid), admins: admins.value.filter(valid) })
    }
    await data.refreshBots()
    step.value = 'done'
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}

async function discard() {
  const id = botId.value
  botId.value = undefined
  if (!id) return
  await call('bots.delete', { id }).catch((error) => message.error((error as Error).message))
  await data.refreshBots().catch(() => {})
}

/** Closed before the end with a bot already made: keep it (it works as it is) or remove it. */
function leave() {
  if (!botId.value || step.value === 'done') return
  const id = botId.value
  dialog.warning({
    title: t('wizard.leaveTitle'),
    content: t('wizard.leaveHint', { name: bot.value?.name ?? '' }),
    positiveText: t('wizard.keep'),
    negativeText: t('wizard.remove'),
    onNegativeClick: () => {
      botId.value = id
      return discard()
    },
  })
}

function openBot() {
  const id = botId.value
  show.value = false
  if (id) router.push(`/bots/${id}`)
}

// ---- summary ----

const state = computed(() => {
  const value = bot.value
  if (!value || !value.enabled) return { cls: 'idle', text: t('wizard.notConnected') }
  if (value.status === 'error') return { cls: 'bad', text: t('bots.state.problem') }
  const cls = value.status === 'online' ? 'ok' : value.status === 'connecting' ? 'warn' : 'idle'
  return { cls, text: t(`bots.state.${value.status}`) }
})
const pluginName = (pkg: string) => localize(catalog.value.find((entry) => entry.package === pkg)?.manifest.displayName, locale.value) || pkg
</script>

<template>
  <Modal v-model:show="show" :title="step === 'done' ? undefined : t('bots.add')" :label="t('bots.add')" :width="640">
    <ol v-if="step !== 'done'" class="steps" :aria-label="t('wizard.steps')">
      <li v-for="(item, i) in STEPS" :key="item" :class="{ on: i === index, past: i < index }" :aria-current="i === index ? 'step' : undefined">
        <span class="step-dot">
          <span v-if="i < index" class="i-lucide-check text-[12px]" />
          <template v-else>{{ i + 1 }}</template>
        </span>
        <span class="step-label">{{ t(`wizard.step.${item}`) }}</span>
      </li>
    </ol>

    <div class="body">
      <!-- 1. platform -->
      <div v-if="step === 'adapter'" class="adapters" role="radiogroup" :aria-label="t('bots.adapter')">
        <button
          v-for="item in data.adapters"
          :key="item.id"
          type="button"
          role="radio"
          class="adapter"
          :class="{ on: item.id === adapterType }"
          :aria-checked="item.id === adapterType"
          @click="pick(item.id)"
          @dblclick="forward"
        >
          <span class="adapter-icon" :style="{ background: `color-mix(in srgb, ${item.color ?? 'var(--primary)'} 14%, transparent)` }">
            <AdapterIcon :adapter="item" :size="22" />
          </span>
          <span class="adapter-text">
            <strong>{{ localize(item.displayName, locale) }}</strong>
            <span v-if="item.description" class="faint">{{ localize(item.description, locale) }}</span>
          </span>
          <span v-if="item.id === adapterType" class="i-lucide-circle-check check text-[18px]" />
        </button>
      </div>

      <!-- 2. connection -->
      <div v-else-if="step === 'connect'" class="connect">
        <div v-if="bot" class="status" :class="state.cls">
          <template v-if="online">
            <div class="account">
              <span class="avatar" :style="{ background: avatarColor(bot.id) }">
                <img v-if="bot.selfAvatar" :src="bot.selfAvatar" alt="" referrerpolicy="no-referrer">
                <template v-else>{{ initial(bot.selfName || bot.name) }}</template>
              </span>
              <div class="account-text">
                <strong>{{ bot.selfName || bot.name }}</strong>
                <span class="faint">{{ bot.selfId ? t('wizard.connectedAs', { id: bot.selfId }) : t('wizard.connected') }}</span>
              </div>
              <span class="pill ok"><span class="dot" />{{ t('bots.state.online') }}</span>
            </div>
            <div v-if="bot.invite" class="invite">
              <QrCode :text="bot.invite" :size="112" />
              <div class="invite-side">
                <strong>{{ t('bots.invite.title') }}</strong>
                <span class="faint">{{ inviteHint }}</span>
                <a :href="bot.invite" target="_blank" rel="noopener"><Button size="small" secondary type="primary">{{ t('bots.invite.open') }}</Button></a>
              </div>
            </div>
          </template>
          <div v-else class="waiting">
            <Spin v-if="bot.status === 'connecting' || connecting" size="small" />
            <span v-else class="i-lucide-circle-alert text-[16px]" />
            <span>{{ bot.status === 'error' ? bot.error : inboundUrl ? t('wizard.waitingInbound') : t('wizard.connecting') }}</span>
          </div>
          <div v-if="inboundUrl && !online" class="url mono">{{ inboundUrl }}</div>
        </div>

        <template v-if="!online && needsSetup">
          <RadioGroup v-if="adapter?.qrSetup && !botId" v-model:value="method" :options="methodOptions" />
          <QrSetup v-if="scanning && adapter?.qrSetup" :key="adapterType" :setup="adapter.qrSetup" :adapter-id="adapterType" @created="scanned" />
          <template v-else>
            <Alert v-if="guide" type="info" :show-icon="false" class="hint">{{ guide }}</Alert>
            <AdapterLinks :adapter="adapter" />
            <SchemaForm v-if="adapter" v-model="config" :schema="adapter.configSchema" :secrets="adapter.secrets" :hidden="hidden" />
          </template>
        </template>
        <p v-else-if="!needsSetup && !bot" class="faint">{{ t('wizard.noSetup') }}</p>
      </div>

      <!-- 3. name -->
      <div v-else-if="step === 'name'" class="name">
        <label class="field">
          <span class="field-label">{{ t('common.name') }}</span>
          <input v-model="name" class="name-input" :placeholder="defaultName()" @input="nameTouched = true" @keyup.enter="forward">
        </label>
        <p class="faint">{{ bot?.selfName ? t('wizard.nameFromAccount') : t('wizard.nameHint') }}</p>
      </div>

      <!-- 4. plugins -->
      <div v-else-if="step === 'plugins'" class="plugins">
        <p class="faint">{{ t('wizard.pluginsHint') }}</p>
        <label v-for="entry in catalog" :key="entry.package" class="plugin" :class="{ on: plugins.includes(entry.package) }">
          <Checkbox :checked="plugins.includes(entry.package)" @update:checked="(on) => (plugins = on ? [...plugins, entry.package] : plugins.filter((item) => item !== entry.package))" />
          <span class="plugin-text">
            <strong>{{ localize(entry.manifest.displayName, locale) || entry.package }}</strong>
            <span class="faint">{{ localize(entry.manifest.description, locale) }}</span>
          </span>
        </label>
        <p v-if="!catalog.length" class="faint">{{ t('wizard.noPlugins') }}</p>
      </div>

      <!-- 5. masters and admins -->
      <div v-else-if="step === 'roles'" class="roles">
        <template v-if="permissions">
          <p class="faint">{{ t('wizard.rolesHint') }}</p>
          <div class="field">
            <span class="field-label">{{ t('permissions.masters') }}</span>
            <TagsInput v-model:value="masters" />
            <div v-if="contacts.length" class="contacts">
              <span class="faint">{{ t('wizard.pickFriend') }}</span>
              <button v-for="contact in contacts" :key="contact.id" type="button" class="contact" :class="{ on: masters.includes(contact.id) }" @click="addMaster(contact.id)">
                {{ contact.remark || contact.name || contact.id }}
              </button>
            </div>
          </div>
          <div class="field">
            <span class="field-label">{{ t('permissions.admins') }}</span>
            <TagsInput v-model:value="admins" />
          </div>
        </template>
        <p v-else class="faint">{{ t('wizard.noPermissions') }}</p>
      </div>

      <!-- done -->
      <div v-else class="done">
        <span class="done-avatar" :style="{ background: avatarColor(botId ?? '') }">
          <img v-if="bot?.selfAvatar" :src="bot.selfAvatar" alt="" referrerpolicy="no-referrer">
          <template v-else>{{ initial(bot?.name ?? name) }}</template>
          <span class="done-badge"><AdapterIcon :adapter="adapter" :size="14" /></span>
        </span>
        <h2>{{ t('wizard.doneTitle', { name: bot?.name ?? name }) }}</h2>
        <span class="pill" :class="state.cls"><span class="dot" />{{ state.text }}</span>
        <p class="faint">
          {{ online ? t('wizard.doneOnline') : t('wizard.doneLater') }}
        </p>
        <div v-if="plugins.length" class="done-plugins">
          <span v-for="item in plugins" :key="item" class="chip">{{ pluginName(item) }}</span>
        </div>
      </div>
    </div>

    <template #footer>
      <template v-if="step === 'done'">
        <Button @click="show = false">{{ t('wizard.backToList') }}</Button>
        <Button type="primary" @click="openBot">{{ t('wizard.openBot') }}</Button>
      </template>
      <template v-else>
        <Button v-if="index > 0" quaternary class="mr-auto" @click="back">{{ t('wizard.back') }}</Button>
        <template v-if="step === 'connect'">
          <Button v-if="!online" @click="forward">{{ t('wizard.later') }}</Button>
          <Button v-if="!online && needsSetup && !scanning" type="primary" :loading="connecting" @click="connect">
            {{ botId ? t('wizard.reconnect') : t('wizard.connectNow') }}
          </Button>
          <Button v-if="online" type="primary" @click="forward">{{ t('wizard.next') }}</Button>
        </template>
        <Button v-else-if="step === 'roles'" type="primary" :loading="saving" @click="finish">{{ t('wizard.finish') }}</Button>
        <Button v-else type="primary" :disabled="step === 'adapter' && !adapter" @click="forward">{{ t('wizard.next') }}</Button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.steps {
  display: flex;
  gap: 4px;
  margin: 0 0 20px;
  padding: 0;
  list-style: none;
}

.steps li {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12.5px;
  color: var(--fg3);
}

.steps li:not(:last-child)::after {
  content: '';
  flex: 1;
  height: 1px;
  margin: 0 4px;
  background: var(--line);
}

.steps li.past::after {
  background: var(--primary);
}

.step-dot {
  display: grid;
  place-items: center;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--s2);
  font-size: 11px;
  font-weight: 600;
}

.on .step-dot,
.past .step-dot {
  background: var(--primary);
  color: #fff;
}

.on {
  color: var(--fg);
  font-weight: 600;
}

.step-label {
  white-space: nowrap;
}

.body {
  min-height: 260px;
}

.faint {
  font-size: 13px;
  color: var(--fg3);
}

p.faint {
  margin: 0;
}

/* platform */
.adapters {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
}

.adapter {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background-color 0.15s;
}

.adapter:hover {
  border-color: var(--primary);
}

.adapter.on {
  border-color: var(--primary);
  background: var(--primary-soft);
}

.adapter:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.adapter-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: 10px;
}

.adapter-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding-right: 18px;
}

.check {
  position: absolute;
  top: 10px;
  right: 10px;
  color: var(--primary);
}

/* connection */
.connect,
.plugins,
.roles,
.name {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.status {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--s1);
}

.status.ok {
  border-color: color-mix(in srgb, var(--ok) 40%, var(--line));
}

.status.bad {
  border-color: color-mix(in srgb, var(--bad) 40%, var(--line));
  color: var(--bad);
}

.waiting {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13.5px;
}

.account {
  display: flex;
  align-items: center;
  gap: 12px;
}

.account-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.avatar,
.done-avatar {
  position: relative;
  display: grid;
  place-items: center;
  flex: none;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: #fff;
  font-weight: 650;
}

.avatar img,
.done-avatar img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.invite {
  display: flex;
  align-items: center;
  gap: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.invite-side {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.url {
  font-size: 13px;
  color: var(--fg);
  user-select: all;
  word-break: break-all;
}

.hint {
  white-space: pre-line;
}

/* name */
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 13px;
  font-weight: 500;
}

.name-input {
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--s1);
  color: var(--fg);
  font: inherit;
  font-size: 15px;
}

.name-input:focus {
  outline: none;
  border-color: var(--primary);
}

/* plugins */
.plugin {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  cursor: pointer;
}

.plugin.on {
  border-color: var(--primary);
  background: var(--primary-soft);
}

.plugin-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

/* roles */
.contacts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.contact,
.chip {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: var(--s1);
  color: var(--fg2);
  font: inherit;
  font-size: 12.5px;
  line-height: 24px;
}

.contact {
  cursor: pointer;
}

.contact:hover,
.contact.on {
  border-color: var(--primary);
  color: var(--primary);
}

/* done */
.done {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 24px 0 8px;
  text-align: center;
}

.done-avatar {
  width: 64px;
  height: 64px;
  font-size: 24px;
}

.done-badge {
  position: absolute;
  right: -2px;
  bottom: -2px;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 2px solid var(--s1);
  border-radius: 50%;
  background: var(--s1);
}

.done h2 {
  margin: 4px 0 0;
  font-size: 18px;
}

.done-plugins {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 9px;
  border-radius: 11px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.pill .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.pill.ok { color: var(--ok); background: var(--ok-soft); }
.pill.warn { color: var(--warn); background: var(--warn-soft); }
.pill.bad { color: var(--bad); background: var(--bad-soft); }
.pill.idle { color: var(--fg2); background: var(--s2); }

@media (max-width: 640px) {
  .step-label {
    display: none;
  }
}
</style>
