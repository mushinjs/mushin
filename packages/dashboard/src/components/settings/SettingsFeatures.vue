<script setup lang="ts">
import { NCheckbox, NCheckboxGroup, NForm, NFormItem, NSpace, NSwitch } from 'naive-ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { OPTIONAL_PAGES, prefs } from '../../prefs'

const { t } = useI18n()

const shownPages = computed({
  get: () => OPTIONAL_PAGES.filter((page) => !prefs.hiddenPages.includes(page)),
  set: (shown: string[]) => (prefs.hiddenPages = OPTIONAL_PAGES.filter((page) => !shown.includes(page))),
})
</script>

<template>
  <NForm label-placement="top" class="form">
    <NFormItem :label="t('settings.features.agentOpen')" :feedback="t('settings.features.agentOpenHelp')">
      <NSwitch v-model:value="prefs.agentOpenOnStart" />
    </NFormItem>
    <NFormItem :label="t('settings.features.pages')" :feedback="t('settings.features.pagesHelp')">
      <NCheckboxGroup v-model:value="shownPages">
        <NSpace>
          <NCheckbox v-for="page in OPTIONAL_PAGES" :key="page" :value="page" :label="t(`nav.${page}`)" />
        </NSpace>
      </NCheckboxGroup>
    </NFormItem>
    <NFormItem :label="t('settings.features.plugins')" :show-feedback="false">
      <span class="muted">
        {{ t('settings.features.pluginsHelp') }}
        <RouterLink to="/plugins">{{ t('settings.features.openPlugins') }}</RouterLink>
      </span>
    </NFormItem>
  </NForm>
</template>

<style scoped>
.form {
  max-width: 640px;
}

.muted {
  font-size: 13px;
  opacity: 0.75;
}
</style>
