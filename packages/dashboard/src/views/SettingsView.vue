<script setup lang="ts">
import { TabPane, Tabs } from '@mushinjs/ui'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import SettingsAbout from '../components/settings/SettingsAbout.vue'
import SettingsAgent from '../components/settings/SettingsAgent.vue'
import SettingsAppearance from '../components/settings/SettingsAppearance.vue'
import SettingsFeatures from '../components/settings/SettingsFeatures.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const section = computed(() => String(route.params.section || 'appearance'))

// Section tabs sit on the left, or on top when the window is narrow.
const width = ref(window.innerWidth)
const onResize = () => (width.value = window.innerWidth)
onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => window.removeEventListener('resize', onResize))
const narrow = computed(() => width.value < 720)
</script>

<template>
  <div class="page">
    <PageHeader :title="t('nav.settings')" :lead="t('settings.lead')" />
    <Tabs
      :value="section"
      :placement="narrow ? 'top' : 'left'"
      @update:value="(next: string) => router.replace(`/settings/${next}`)"
    >
      <TabPane name="appearance" :tab="t('settings.sections.appearance')" data-agent-target="settings.appearance">
        <SettingsAppearance />
      </TabPane>
      <TabPane name="features" :tab="t('settings.sections.features')" data-agent-target="settings.features">
        <SettingsFeatures />
      </TabPane>
      <TabPane name="agent" :tab="t('settings.sections.agent')" data-agent-target="settings.agent">
        <SettingsAgent />
      </TabPane>
      <TabPane name="about" :tab="t('settings.sections.about')" data-agent-target="settings.about">
        <SettingsAbout />
      </TabPane>
    </Tabs>
  </div>
</template>

