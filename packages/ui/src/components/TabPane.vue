<script setup lang="ts">
/** One tab of Tabs: `tab` is its label, the default slot its content. */
import { TabsContent } from 'reka-ui'
import { inject, onBeforeUnmount } from 'vue'
import { TABS } from './tabs'

const props = defineProps<{ name: string; tab?: string; icon?: string; disabled?: boolean }>()
const tabs = inject(TABS)!
const unregister = tabs.register({ name: props.name, tab: () => props.tab, icon: () => props.icon, disabled: () => !!props.disabled })
onBeforeUnmount(unregister)
</script>

<template>
  <TabsContent class="mu-tab-pane" :value="name">
    <slot />
  </TabsContent>
</template>

<style>
.mu-tab-pane { padding-top: 14px; }
.mu-tab-pane:focus-visible { outline: none; }
</style>
