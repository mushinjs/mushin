<script setup lang="ts">
import { Alert, Button, Card, Form, FormItem, Spin, TagsInput, useToast } from '@mushinjs/ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { call, on } from '../api'
import type { AppPlugin, Bot } from '../types'
import BotChatPermissions from './BotChatPermissions.vue'

/** A bot's masters and admins, kept by the permissions plugin. */
const props = defineProps<{ bot: Bot }>()
const { t } = useI18n()
const message = useToast()

const masters = ref<string[]>([])
const admins = ref<string[]>([])
const groupRoles = ref(false)
/** Chat members and rules need the database plugin. */
const chats = ref(false)
const chatCommands = ref(false)
const available = ref<boolean>()
const loading = ref(true)
const saving = ref(false)

async function refresh() {
  try {
    const plugins = await call<AppPlugin[]>('plugins.list')
    available.value = plugins.some((plugin) => plugin.package === '@mushinjs/plugin-permissions' && plugin.status === 'active')
    if (!available.value) return
    const result = await call<{ masters: string[]; admins: string[]; groupRoles: boolean; chats: boolean; chatCommands: boolean }>('permissions.get', { bot: props.bot.id })
    chats.value = result.chats
    chatCommands.value = result.chatCommands
    masters.value = result.masters
    admins.value = result.admins
    groupRoles.value = result.groupRoles
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(refresh)
watch(() => props.bot.id, refresh)
const off = on('manager/changed', refresh)
onBeforeUnmount(off)

const valid = (id: string) => /^\S+$/.test(id)
const overlap = computed(() => admins.value.filter((id) => masters.value.includes(id)))

async function save() {
  saving.value = true
  try {
    const result = await call<{ masters: string[]; admins: string[] }>('permissions.update', {
      bot: props.bot.id,
      masters: masters.value.filter(valid),
      admins: admins.value.filter(valid),
    })
    masters.value = result.masters
    admins.value = result.admins
    message.success(t('common.saved'))
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Spin :show="loading">
    <Alert v-if="available === false" type="warning" :title="t('permissions.unavailable')">
      {{ t('permissions.unavailableHint') }}
      <RouterLink to="/plugins?highlight=@mushinjs/plugin-permissions">{{ t('permissions.openPlugins') }}</RouterLink>
    </Alert>
    <div v-else class="flex flex-col gap-[16px]">
      <Card :title="t('permissions.title')">
        <div class="flex flex-col gap-[18px]">
          <p class="muted lead">{{ t('permissions.lead') }}</p>
          <Form>
            <FormItem :label="t('permissions.masters')" :feedback="t('permissions.mastersHint')">
              <TagsInput v-model:value="masters" />
            </FormItem>
            <FormItem :label="t('permissions.admins')" :feedback="t('permissions.adminsHint')">
              <TagsInput v-model:value="admins" />
            </FormItem>
          </Form>
          <Alert v-if="overlap.length" type="info" :show-icon="false" class="note">{{ t('permissions.overlap', { ids: overlap.join('、') }) }}</Alert>
          <div class="flex flex-wrap gap-x-3 gap-y-2 items-center justify-end">
            <Button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</Button>
          </div>
        </div>
      </Card>
      <BotChatPermissions v-if="chats" v-model:chat-commands="chatCommands" :bot="bot" />
      <Alert v-else type="info" :title="t('chatPermissions.title')">
        {{ t('chatPermissions.needsDatabase') }}
        <RouterLink to="/plugins?highlight=@mushinjs/plugin-database">{{ t('permissions.openPlugins') }}</RouterLink>
      </Alert>
      <Card :title="t('permissions.usageTitle')">
        <ul class="usage">
          <li>{{ t('permissions.usageCommands') }}</li>
          <li>{{ t('permissions.usageNode') }}</li>
          <li>{{ groupRoles ? t('permissions.groupRolesYes') : t('permissions.groupRolesNo') }}</li>
          <li>{{ t('permissions.usageAgent') }}</li>
        </ul>
      </Card>
    </div>
  </Spin>
</template>

<style scoped>
.lead {
  margin: 0;
}

.usage {
  margin: 0;
  padding-left: 20px;
  line-height: 1.8;
}
</style>
