<script setup lang="ts">
const tabs = useAllTabs()
const activeTab = computed(() => useRoute().path)
</script>

<template>
  <aside
    border="r base" flex="~ col"
    h-full items-start of-hidden bg-base
  >
    <div flex="~ justify-center" w-full px-2 py-4>
      <UnoIcon text-2xl icon="i-carbon:dashboard" />
    </div>

    <div m-auto my-1 w-8 h-1px border="b base" />

    <div flex="~ auto col items-center gap-4" px2 py4 w-full of-x-hidden class="no-scrollbar">
      <template v-for="item in tabs" :key="item.name">
        <NuxtLink
          :to="item.path"
        >
          <VTooltip
            placement="right"
          >
            <div
              p-2 rounded hover="bg-active"
              :class="activeTab.startsWith(item.path) ? 'bg-active' : ''"
            >
              <UnoIcon text-2xl :icon="item.icon" />
            </div>
            <template #popper>
              <div>
                {{ item.title }}
              </div>
            </template>
          </VTooltip>
        </NuxtLink>
      </template>
    </div>

    <div flex="~ justify-center" p-4 w-full>
      <NuxtLink to="/settings">
        <VTooltip
          placement="right" p-2 rounded hover="bg-active"
          :class="activeTab.startsWith('/settings') ? 'bg-active' : ''"
        >
          <UnoIcon text-2xl icon="i-carbon-settings" />
          <template #popper>
            <div>
              settings
            </div>
          </template>
        </VTooltip>
      </NuxtLink>
    </div>
  </aside>
</template>

<style>
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
</style>
