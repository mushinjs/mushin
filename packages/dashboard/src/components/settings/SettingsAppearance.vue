<script setup lang="ts">
import { NForm, NFormItem, NRadioButton, NRadioGroup } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { setLocale } from '../../i18n'
import { themeMode } from '../../theme'

const { t, locale } = useI18n()
</script>

<template>
  <NForm label-placement="top" class="form">
    <NFormItem :label="t('settings.appearance.theme')" :feedback="t('settings.appearance.themeHelp')">
      <NRadioGroup v-model:value="themeMode">
        <NRadioButton value="auto">{{ t('settings.appearance.auto') }}</NRadioButton>
        <NRadioButton value="light">{{ t('settings.appearance.light') }}</NRadioButton>
        <NRadioButton value="dark">{{ t('settings.appearance.dark') }}</NRadioButton>
      </NRadioGroup>
    </NFormItem>
    <NFormItem :label="t('settings.appearance.language')" :feedback="t('settings.appearance.languageHelp')">
      <NRadioGroup :value="locale" @update:value="setLocale">
        <NRadioButton value="zh-CN">简体中文</NRadioButton>
        <NRadioButton value="en">English</NRadioButton>
      </NRadioGroup>
    </NFormItem>
  </NForm>
</template>

<style scoped>
.form {
  max-width: 560px;
}
</style>
