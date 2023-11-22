<script setup lang="ts">
const { x, y } = useMouse()

const color = useColorMode()
function toggleDarkMode() {
  color.value = color.value === 'dark' ? 'light' : 'dark'
}
</script>

<template>
  <div text-red>
    Hello World {{ x }}, {{ y }}
    <button @click="toggleDarkMode">
      {{ color.value }}
    </button>
  </div>
</template>
