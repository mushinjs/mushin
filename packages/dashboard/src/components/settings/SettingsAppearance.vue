<script setup lang="ts">
import { Form, FormItem, RadioButton, RadioGroup } from '@mushin/ui'
import { useI18n } from 'vue-i18n'
import { setLocale } from '../../i18n'
import { themeMode } from '../../theme'

const { t, locale } = useI18n()
</script>

<template>
  <Form class="form">
    <FormItem :label="t('settings.appearance.theme')" :feedback="t('settings.appearance.themeHelp')">
      <RadioGroup v-model:value="themeMode">
        <RadioButton value="auto">{{ t('settings.appearance.auto') }}</RadioButton>
        <RadioButton value="light">{{ t('settings.appearance.light') }}</RadioButton>
        <RadioButton value="dark">{{ t('settings.appearance.dark') }}</RadioButton>
      </RadioGroup>
    </FormItem>
    <FormItem :label="t('settings.appearance.language')" :feedback="t('settings.appearance.languageHelp')">
      <RadioGroup :value="locale" @update:value="setLocale">
        <RadioButton value="zh-CN">简体中文</RadioButton>
        <RadioButton value="en">English</RadioButton>
      </RadioGroup>
    </FormItem>
  </Form>
</template>

<style scoped>
.form {
  max-width: 560px;
}
</style>
