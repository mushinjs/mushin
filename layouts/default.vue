<script setup lang="ts">
defineProps<{
  modelValue?: boolean
}>()
</script>

<template>
  <div w-screen h-screen h-100dvh flex="~" of-hidden>
    <SideNav />
    <main flex-auto>
      <slot />
    </main>
  </div>
</template>
