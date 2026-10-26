<script setup lang="ts">
import { NTabPane, NTabs } from 'naive-ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import AgentMcp from '../components/agent/AgentMcp.vue'
import AgentModel from '../components/agent/AgentModel.vue'
import AgentScenes from '../components/agent/AgentScenes.vue'
import AgentSkills from '../components/agent/AgentSkills.vue'
import AgentStyles from '../components/agent/AgentStyles.vue'
import AgentTools from '../components/agent/AgentTools.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const tab = computed(() => String(route.params.tab || 'scenes'))
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>{{ t('nav.agent') }}</h1>
        <p class="page-lead">{{ t('agentPage.lead') }}</p>
      </div>
    </div>
    <NTabs :value="tab" type="line" animated @update:value="(next: string) => router.replace(`/agent/${next}`)">
      <NTabPane name="scenes" :tab="t('agentPage.tabs.scenes')" display-directive="show:lazy"><AgentScenes /></NTabPane>
      <NTabPane name="skills" :tab="t('agentPage.tabs.skills')" display-directive="show:lazy"><AgentSkills /></NTabPane>
      <NTabPane name="mcp" :tab="t('agentPage.tabs.mcp')" display-directive="show:lazy"><AgentMcp /></NTabPane>
      <NTabPane name="tools" :tab="t('agentPage.tabs.tools')" display-directive="show:lazy"><AgentTools /></NTabPane>
      <NTabPane name="model" :tab="t('agentPage.tabs.model')" display-directive="show:lazy"><AgentModel /></NTabPane>
      <NTabPane name="styles" :tab="t('agentPage.tabs.styles')" display-directive="show:lazy"><AgentStyles /></NTabPane>
    </NTabs>
  </div>
</template>
