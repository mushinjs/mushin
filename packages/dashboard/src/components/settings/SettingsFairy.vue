<script setup lang="ts">
import { TabPane, Tabs } from '@mushinjs/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import FairyMcp from '../fairy/FairyMcp.vue'
import FairyModel from '../fairy/FairyModel.vue'
import FairyScenes from '../fairy/FairyScenes.vue'
import FairySkills from '../fairy/FairySkills.vue'
import FairyStyles from '../fairy/FairyStyles.vue'
import FairyTools from '../fairy/FairyTools.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const tab = computed(() => String(route.params.tab || 'scenes'))
</script>

<template>
  <div>
    <p class="section-lead">{{ t('fairyPage.lead') }}</p>
    <Tabs :value="tab" @update:value="(next: string) => router.replace(`/settings/fairy/${next}`)">
      <TabPane name="scenes" :tab="t('fairyPage.tabs.scenes')"><FairyScenes /></TabPane>
      <TabPane name="skills" :tab="t('fairyPage.tabs.skills')"><FairySkills /></TabPane>
      <TabPane name="mcp" :tab="t('fairyPage.tabs.mcp')"><FairyMcp /></TabPane>
      <TabPane name="tools" :tab="t('fairyPage.tabs.tools')"><FairyTools /></TabPane>
      <TabPane name="model" :tab="t('fairyPage.tabs.model')"><FairyModel /></TabPane>
      <TabPane name="styles" :tab="t('fairyPage.tabs.styles')"><FairyStyles /></TabPane>
    </Tabs>
  </div>
</template>
