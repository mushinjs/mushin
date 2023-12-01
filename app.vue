<script>
import '@unocss/reset/tailwind.css'
</script>

<template>
  <div w-screen h-screen h-100dvh grid="~ cols-[72px_1fr]" of-hidden>
    <SideNav />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </div>
</template>

<style>
.dark {
  color-scheme: dark;
}
</style>
