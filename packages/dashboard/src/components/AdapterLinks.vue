<script setup lang="ts">
import { Button } from '@mushinjs/ui'
import { useI18n } from 'vue-i18n'
import type { AdapterType } from '../types'
import { localize } from '../utils'

/** The adapter's setup pages, such as its developer portal; links like t.me open the desktop app when it is installed. */
defineProps<{ adapter: AdapterType | undefined }>()
const { locale } = useI18n()
</script>

<template>
  <div v-if="adapter?.links?.length" class="links">
    <a v-for="link in adapter.links" :key="link.url" :href="link.url" target="_blank" rel="noopener">
      <Button size="small" secondary>
        {{ localize(link.label, locale) }}<span class="i-lucide-external-link text-[13px] ml-1" />
      </Button>
    </a>
  </div>
</template>

<style scoped>
.links {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
