<script setup lang="ts">
const color = useColorMode()
const isDark = computed<boolean>({
  get() {
    return color.value === 'dark'
  },
  set() {
    color.value = isDark.value ? 'light' : 'dark'
  },
})

const isAppearanceTransition = typeof document !== 'undefined'
  // @ts-expect-error: Transition API
  && document.startViewTransition
  && !window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Credit to [@hooray](https://github.com/hooray)
 * @see https://github.com/vuejs/vitepress/pull/2347
 */
function toggleDarkMode(event?: MouseEvent) {
  if (!isAppearanceTransition || !event) {
    isDark.value = !isDark.value
    return
  }

  const x = event.clientX
  const y = event.clientY
  const endRadius = Math.hypot(
    Math.max(x, innerWidth - x),
    Math.max(y, innerHeight - y),
  )

  // @ts-expect-error: Transition API
  const transition = document.startViewTransition(async () => {
    isDark.value = !isDark.value
    await nextTick()
  })

  transition.ready.then(() => {
    const clipPath = [
      `circle(0px at ${x}px ${y}px)`,
      `circle(${endRadius}px at ${x}px ${y}px)`,
    ]
    document.documentElement.animate(
      {
        clipPath: isDark.value
          ? [...clipPath].reverse()
          : clipPath,
      },
      {
        duration: 400,
        easing: 'ease-in',
        pseudoElement: isDark.value
          ? '::view-transition-old(root)'
          : '::view-transition-new(root)',
      },
    )
  })
}
</script>

<template>
  <div px-8 py-6>
    <div flex="~ items-center" gap-3 text-xl mb-4>
      <div i-carbon:settings-adjust />
      <div>Mushin Settings</div>
    </div>
    <div grid="~ md:cols-2 gap-x-10 gap-y-3" max-w-300>
      <div>
        <div text-lg>
          Appearance
        </div>

        <div border="~ base rounded" mt-2 p4>
          <button flex="~ gap-2 items-center" border="~ base rounded" px-2 py-1 @click="toggleDarkMode">
            <div i-carbon:sun dark:i-carbon:moon text-xl />
            {{ color.value[0].toUpperCase() + color.value.slice(1) }}
          </button>
        </div>
      </div>
      <div>
        <div text-lg>
          Appearance
        </div>
        <div border="~ base rounded" mt-2 p4>
          <button flex="~ gap-2 items-center" border="~ base rounded" px-2 py-1 @click="toggleDarkMode">
            <div i-carbon:sun dark:i-carbon:moon text-xl />
            {{ color.value[0].toUpperCase() + color.value.slice(1) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
/* Color Mode transition */
::view-transition-old(root),
::view-transition-new(root) {
  animation: none;
  mix-blend-mode: normal;
}
::view-transition-old(root) {
  z-index: 1;
}
::view-transition-new(root) {
  z-index: 2147483646;
}
.dark::view-transition-old(root) {
  z-index: 2147483646;
}
.dark::view-transition-new(root) {
  z-index: 1;
}
</style>
