<script setup lang="ts">
import { NAlert, NButton, NCard, NDynamicTags, NForm, NFormItem, NSpace, NSpin, useMessage } from 'naive-ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { call, on } from '../api'
import type { AppPlugin, Bot } from '../types'

/** A bot's masters and admins, kept by the permissions plugin. */
const props = defineProps<{ bot: Bot }>()
const { t } = useI18n()
const message = useMessage()

const masters = ref<string[]>([])
const admins = ref<string[]>([])
const groupRoles = ref(false)
const available = ref<boolean>()
const loading = ref(true)
const saving = ref(false)

async function refresh() {
  try {
    const plugins = await call<AppPlugin[]>('plugins.list')
    available.value = plugins.some((plugin) => plugin.package === '@mushin/plugin-permissions' && plugin.status === 'active')
    if (!available.value) return
    const result = await call<{ masters: string[]; admins: string[]; groupRoles: boolean }>('permissions.get', { bot: props.bot.id })
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
  <NSpin :show="loading">
    <NAlert v-if="available === false" type="warning" :title="t('permissions.unavailable')">
      {{ t('permissions.unavailableHint') }}
      <RouterLink to="/plugins?highlight=@mushin/plugin-permissions">{{ t('permissions.openPlugins') }}</RouterLink>
    </NAlert>
    <NSpace v-else vertical :size="16">
      <NCard :title="t('permissions.title')">
        <p class="muted lead">{{ t('permissions.lead') }}</p>
        <NForm label-placement="top">
          <NFormItem :label="t('permissions.masters')" :feedback="t('permissions.mastersHint')">
            <NDynamicTags v-model:value="masters" />
          </NFormItem>
          <NFormItem :label="t('permissions.admins')" :feedback="t('permissions.adminsHint')">
            <NDynamicTags v-model:value="admins" />
          </NFormItem>
        </NForm>
        <NAlert v-if="overlap.length" type="info" :show-icon="false" class="note">{{ t('permissions.overlap', { ids: overlap.join('、') }) }}</NAlert>
        <NSpace justify="end">
          <NButton type="primary" :loading="saving" @click="save">{{ t('common.save') }}</NButton>
        </NSpace>
      </NCard>
      <NCard :title="t('permissions.usageTitle')">
        <ul class="usage">
          <li>{{ t('permissions.usageCommands') }}</li>
          <li>{{ t('permissions.usageNode') }}</li>
          <li>{{ groupRoles ? t('permissions.groupRolesYes') : t('permissions.groupRolesNo') }}</li>
          <li>{{ t('permissions.usageAgent') }}</li>
        </ul>
      </NCard>
    </NSpace>
  </NSpin>
</template>

<style scoped>
.lead {
  margin: 0 0 12px;
}

.note {
  margin-bottom: 12px;
}

.usage {
  margin: 0;
  padding-left: 20px;
  line-height: 1.8;
}
</style>
