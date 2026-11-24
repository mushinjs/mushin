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
import { confetti } from '../confetti'
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
const STEP_ICONS: Record<Step, string> = {
  adapter: 'i-lucide-layout-grid',
  connect: 'i-lucide-link',
  name: 'i-lucide-pen-line',
  plugins: 'i-lucide-puzzle',
  roles: 'i-lucide-shield-check',
  done: 'i-lucide-check',
}
const DEFAULT_PLUGINS = ['@mushinjs/bot-plugin-llm-chat']

const step = ref<Step>('adapter')
/** Which way the last step change went, so the panes slide the right way. */
const direction = ref<'next' | 'prev'>('next')
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
  direction.value = 'next'
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
  direction.value = STEPS.indexOf(next) < index.value ? 'prev' : 'next'
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
  if (!permissions.value || !online.value) return
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
    direction.value = 'next'
    step.value = 'done'
    confetti()
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
    <nav v-if="step !== 'done'" class="stepper" :aria-label="t('wizard.steps')">
      <div class="track" aria-hidden="true"><div class="track-fill" :style="{ transform: `scaleX(${index / (STEPS.length - 1)})` }" /></div>
      <ol class="steps">
        <li v-for="(item, i) in STEPS" :key="item" :class="{ on: i === index, past: i < index }">
          <button type="button" class="step" :disabled="i >= index" :aria-current="i === index ? 'step' : undefined" @click="go(item)">
            <span class="step-dot">
              <Transition name="pop" mode="out-in">
                <span v-if="i < index" key="done" class="i-lucide-check text-[14px]" />
                <span v-else key="icon" class="text-[14px]" :class="STEP_ICONS[item]" />
              </Transition>
            </span>
            <span class="step-label">{{ t(`wizard.step.${item}`) }}</span>
          </button>
        </li>
      </ol>
    </nav>

    <div class="body">
      <Transition :name="`slide-${direction}`" mode="out-in">
      <div :key="step" class="pane">
      <header v-if="step !== 'done'" class="pane-head">
        <h3>{{ t(`wizard.title.${step}`) }}</h3>
        <p>{{ t(`wizard.lead.${step}`, { adapter: adapterName }) }}</p>
      </header>

      <!-- 1. platform -->
      <div v-if="step === 'adapter'" class="adapters" role="radiogroup" :aria-label="t('bots.adapter')">
        <button
          v-for="(item, i) in data.adapters"
          :key="item.id"
          type="button"
          role="radio"
          class="adapter"
          :class="{ on: item.id === adapterType }"
          :aria-checked="item.id === adapterType"
          :style="{ animationDelay: `${i * 40}ms` }"
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
          <Transition name="pop"><span v-if="item.id === adapterType" class="i-lucide-circle-check check text-[18px]" /></Transition>
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
          <span class="done-ring" aria-hidden="true" />
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
      </Transition>
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
.stepper {
  position: relative;
  margin: 2px 0 22px;
}

/* The line behind the dots, filled up to the current step. */
.track {
  position: absolute;
  top: 15px;
  left: 10%;
  right: 10%;
  height: 2px;
  border-radius: 1px;
  background: var(--line);
}

.track-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--primary), color-mix(in srgb, var(--primary) 70%, #8A63D2));
  transform-origin: left;
  transition: transform 0.45s cubic-bezier(0.22, 1, 0.36, 1);
}

.steps {
  position: relative;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin: 0;
  padding: 0;
  list-style: none;
}

.step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: var(--fg3);
  font: inherit;
  font-size: 12.5px;
}

.step:not(:disabled) {
  cursor: pointer;
}

.step:not(:disabled):hover .step-label {
  color: var(--primary);
}

.step-dot {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 2px solid var(--line);
  border-radius: 50%;
  background: var(--s1);
  transition: background-color 0.3s, border-color 0.3s, color 0.3s, box-shadow 0.3s, transform 0.3s;
}

.past .step-dot {
  border-color: var(--primary);
  background: var(--primary);
  color: #fff;
}

.on .step-dot {
  border-color: var(--primary);
  color: var(--primary);
  box-shadow: 0 0 0 5px var(--primary-soft);
  transform: scale(1.08);
}

.step-label {
  white-space: nowrap;
  transition: color 0.3s;
}

.on .step-label {
  color: var(--fg);
  font-weight: 600;
}

.past .step-label {
  color: var(--fg2);
}

.pane-head {
  margin-bottom: 16px;
}

.pane-head h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
}

.pane-head p {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--fg3);
}

/* Panes slide in the way the steps go. */
.slide-next-enter-active,
.slide-next-leave-active,
.slide-prev-enter-active,
.slide-prev-leave-active {
  transition: opacity 0.22s ease, transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}

.slide-next-enter-from,
.slide-prev-leave-to {
  opacity: 0;
  transform: translateX(28px);
}

.slide-next-leave-to,
.slide-prev-enter-from {
  opacity: 0;
  transform: translateX(-28px);
}

.pop-enter-active {
  transition: opacity 0.2s, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.pop-leave-active {
  transition: opacity 0.12s;
}

.pop-enter-from {
  opacity: 0;
  transform: scale(0.4);
}

.pop-leave-to {
  opacity: 0;
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

@keyframes avatar-in {
  0% { opacity: 0; transform: scale(0.3) rotate(-12deg); }
  60% { opacity: 1; transform: scale(1.12) rotate(3deg); }
  100% { transform: scale(1) rotate(0); }
}

@keyframes ring {
  from { opacity: 0.6; transform: scale(1); }
  to { opacity: 0; transform: scale(1.8); }
}

.body {
  min-height: 320px;
  overflow-x: hidden;
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
  animation: rise 0.35s cubic-bezier(0.22, 1, 0.36, 1) backwards;
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
  transition: border-color 0.15s, background-color 0.15s, transform 0.15s, box-shadow 0.15s;
}

.adapter:hover {
  border-color: var(--primary);
  box-shadow: var(--shadow);
  transform: translateY(-2px);
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
  width: 72px;
  height: 72px;
  font-size: 26px;
  animation: avatar-in 0.6s cubic-bezier(0.22, 1, 0.36, 1) 0.1s backwards;
}

.done-ring {
  position: absolute;
  inset: 0;
  border: 2px solid var(--primary);
  border-radius: 50%;
  animation: ring 1.2s ease-out 0.4s 2 backwards;
  pointer-events: none;
}

.done > :not(.done-avatar) {
  animation: rise 0.4s cubic-bezier(0.22, 1, 0.36, 1) 0.35s backwards;
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

@media (prefers-reduced-motion: reduce) {
  .slide-next-enter-active,
  .slide-next-leave-active,
  .slide-prev-enter-active,
  .slide-prev-leave-active,
  .adapter,
  .done-avatar,
  .done-ring,
  .done > * {
    animation: none;
    transition: none;
  }
}
</style>
