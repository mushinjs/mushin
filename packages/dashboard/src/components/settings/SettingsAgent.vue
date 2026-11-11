<script setup lang="ts">
import { TabPane, Tabs } from '@mushinjs/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import AgentMcp from '../agent/AgentMcp.vue'
import AgentModel from '../agent/AgentModel.vue'
import AgentScenes from '../agent/AgentScenes.vue'
import AgentSkills from '../agent/AgentSkills.vue'
import AgentStyles from '../agent/AgentStyles.vue'
import AgentTools from '../agent/AgentTools.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const tab = computed(() => String(route.params.tab || 'scenes'))
</script>

<template>
  <div>
    <p class="section-lead">{{ t('agentPage.lead') }}</p>
    <Tabs :value="tab" @update:value="(next: string) => router.replace(`/settings/agent/${next}`)">
      <TabPane name="scenes" :tab="t('agentPage.tabs.scenes')"><AgentScenes /></TabPane>
      <TabPane name="skills" :tab="t('agentPage.tabs.skills')"><AgentSkills /></TabPane>
      <TabPane name="mcp" :tab="t('agentPage.tabs.mcp')"><AgentMcp /></TabPane>
      <TabPane name="tools" :tab="t('agentPage.tabs.tools')"><AgentTools /></TabPane>
      <TabPane name="model" :tab="t('agentPage.tabs.model')"><AgentModel /></TabPane>
      <TabPane name="styles" :tab="t('agentPage.tabs.styles')"><AgentStyles /></TabPane>
    </Tabs>
  </div>
</template>
