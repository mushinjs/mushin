<script setup lang="ts">
import { Checkbox, Form, FormItem, Toggle } from '@mushinjs/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { OPTIONAL_PAGES, prefs } from '../../prefs'

const { t } = useI18n()

const shownPages = computed({
  get: () => OPTIONAL_PAGES.filter((page) => !prefs.hiddenPages.includes(page)),
  set: (shown: string[]) => (prefs.hiddenPages = OPTIONAL_PAGES.filter((page) => !shown.includes(page))),
})

function showPage(page: string, shown: boolean) {
  shownPages.value = shown ? [...shownPages.value, page] : shownPages.value.filter((item) => item !== page)
}
</script>

<template>
  <Form class="form">
    <FormItem :label="t('settings.features.agentOpen')" :feedback="t('settings.features.agentOpenHelp')">
      <Toggle v-model:value="prefs.agentOpenOnStart" />
    </FormItem>
    <FormItem :label="t('settings.features.pages')" :feedback="t('settings.features.pagesHelp')">
      <div class="pages">
        <Checkbox
          v-for="page in OPTIONAL_PAGES"
          :key="page"
          :checked="shownPages.includes(page)"
          @update:checked="(shown) => showPage(page, shown)"
        >
          {{ t(`nav.${page}`) }}
        </Checkbox>
      </div>
    </FormItem>
    <FormItem :label="t('settings.features.plugins')">
      <span class="muted">
        {{ t('settings.features.pluginsHelp') }}
        <RouterLink to="/plugins">{{ t('settings.features.openPlugins') }}</RouterLink>
      </span>
    </FormItem>
  </Form>
</template>

<style scoped>
.form {
  max-width: 640px;
}

.pages {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}

.muted {
  font-size: 13px;
  opacity: 0.75;
}
</style>
