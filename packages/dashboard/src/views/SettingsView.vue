<script setup lang="ts">
import { NTabPane, NTabs } from 'naive-ui'
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
    <NTabs
      :value="section"
      type="line"
      :placement="narrow ? 'top' : 'left'"
      :pane-style="narrow ? undefined : 'padding: 0 0 0 24px; min-width: 0;'"
      class="sections"
      @update:value="(next: string) => router.replace(`/settings/${next}`)"
    >
      <NTabPane name="appearance" :tab="t('settings.sections.appearance')" display-directive="show:lazy" data-agent-target="settings.appearance">
        <SettingsAppearance />
      </NTabPane>
      <NTabPane name="features" :tab="t('settings.sections.features')" display-directive="show:lazy" data-agent-target="settings.features">
        <SettingsFeatures />
      </NTabPane>
      <NTabPane name="agent" :tab="t('settings.sections.agent')" display-directive="show:lazy" data-agent-target="settings.agent">
        <SettingsAgent />
      </NTabPane>
      <NTabPane name="about" :tab="t('settings.sections.about')" display-directive="show:lazy" data-agent-target="settings.about">
        <SettingsAbout />
      </NTabPane>
    </NTabs>
  </div>
</template>

<style scoped>
.sections :deep(.n-tabs-nav--left) {
  min-width: 120px;
}

/* Naive UI's left-placement padding also reaches tabs nested in a section (the Agent's); give them back their own. */
.sections :deep(.n-tabs--top .n-tab-pane) {
  padding: var(--n-pane-padding-top) var(--n-pane-padding-right) var(--n-pane-padding-bottom) var(--n-pane-padding-left);
}
</style>
