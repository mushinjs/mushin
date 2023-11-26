<script setup lang="ts">

</script>

<template>
  <aside
    border="r base" flex="~ col"
    h-full items-start of-hidden bg-base
  >
    <div flex="~ justify-center" w-full px-2 py-4>
      <UnoIcon text-2xl icon="i-carbon:dashboard" />
    </div>

    <div my1 w-full h-1px border="b base" />

    <div flex="~ auto col items-center gap-4" px2 py4 w-full of-x-hidden class="no-scrollbar">
      <VTooltip placement="right" bg-active p-2 rounded hover="bg-active">
        <NuxtLink to="/">
          <UnoIcon text-2xl icon="i-carbon-home" />
        </NuxtLink>
        <template #popper>
          <div>
            home
          </div>
        </template>
      </VTooltip>
      <VTooltip placement="right" p-2 rounded hover="bg-active">
        <NuxtLink to="/test">
          <UnoIcon
            text-2xl
            icon="i-carbon:assembly-reference"
          />
        </NuxtLink>
        <template #popper>
          <div>
            test
          </div>
        </template>
      </VTooltip>
    </div>

    <div flex="~ justify-center" p-4 w-full>
      <VTooltip placement="right" p-2 rounded hover="bg-active">
        <NuxtLink to="/settings">
          <UnoIcon text-2xl icon="i-carbon-settings" />
        </NuxtLink>
        <template #popper>
          <div>
            settings
          </div>
        </template>
      </VTooltip>
    </div>
  </aside>
</template>

<style>
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
</style>
