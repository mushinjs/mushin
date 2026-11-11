<script setup lang="ts">
import { Card } from '@mushinjs/ui'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { call } from '../../api'
import type { StatsOverview } from '../../types'

const { t } = useI18n()

const overview = ref<StatsOverview>()
const info = ref<{ baseUrl: string; node: string; platform: string }>()
const logoFailed = ref(false)

onMounted(() => {
  // The stats plugin can be turned off; system.info is always there.
  call<StatsOverview>('stats.overview').then((value) => (overview.value = value)).catch(() => {})
  call<{ baseUrl: string; node: string; platform: string }>('system.info').then((value) => (info.value = value)).catch(() => {})
})
</script>

<template>
  <div class="about">
    <div class="brand">
      <img v-if="!logoFailed" src="/logo.png" alt="" class="logo" @error="logoFailed = true">
      <div>
        <div class="name">Mushin.js <span class="kanji">無心</span></div>
        <div class="tagline">{{ t('app.tagline') }}</div>
      </div>
    </div>

    <Card :title="t('settings.about.instance')" size="small">
      <dl class="facts">
        <dt>Mushin.js</dt><dd>{{ overview?.versions.mushin ?? '—' }}</dd>
        <dt>Cordis</dt><dd>{{ overview?.versions.cordis ?? '—' }}</dd>
        <dt>Node.js</dt><dd>{{ overview?.versions.node ?? info?.node ?? '—' }}</dd>
        <dt>{{ t('overview.platform') }}</dt><dd>{{ overview?.platform ?? info?.platform ?? '—' }}</dd>
        <dt>{{ t('settings.about.address') }}</dt><dd class="mono">{{ info?.baseUrl ?? '—' }}</dd>
        <dt>{{ t('settings.about.license') }}</dt><dd>MIT</dd>
      </dl>
    </Card>

    <p class="credits">
      {{ t('settings.about.builtOn') }}
      <a href="https://github.com/cordiverse/cordis" target="_blank" rel="noopener">Cordis</a>
      · <a href="https://napneko.github.io/" target="_blank" rel="noopener">NapCat</a>
      · <a href="https://reka-ui.com/" target="_blank" rel="noopener">Reka UI</a>
      · <a href="https://unocss.dev/" target="_blank" rel="noopener">UnoCSS</a>
    </p>
  </div>
</template>

<style scoped>
.about {
  max-width: 560px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 14px;
}

.logo {
  width: 56px;
  height: 56px;
}

.name {
  font-size: 20px;
  font-weight: 650;
}

.kanji {
  font-weight: 400;
  opacity: 0.55;
}

.tagline {
  font-size: 13px;
  opacity: 0.65;
  margin-top: 2px;
}

.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 0;
  font-size: 13px;
}

.facts dt {
  opacity: 0.65;
}

.facts dd {
  margin: 0;
  word-break: break-all;
}

.credits {
  margin: 0;
  font-size: 13px;
  opacity: 0.75;
}
</style>
