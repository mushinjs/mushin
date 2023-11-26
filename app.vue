<script>
import '@unocss/reset/tailwind.css'
</script>

<template>
  <div>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </div>
</template>

<style>
.dark {
  color-scheme: dark;
}
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
</style>
