<script setup lang="ts">
/**
 * The sidebar. Collapsing only narrows it: every icon, group and the footer keep their place, so
 * nothing jumps. It moves in two steps driven by two flags, so no word is ever seen half cut:
 * closing, the words fade out first (`quiet`) and only then the panel narrows (`narrow`); opening,
 * the panel widens first and the words fade in once there is room for them. Both steps are CSS
 * transitions on classes, so they hold whatever Vue re-renders in between.
 */
import { Tooltip } from '@mushin/ui'
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { NavGroup } from './nav'

defineProps<{ groups: NavGroup[], active: string }>()
const collapsed = defineModel<boolean>('collapsed', { required: true })
const { t } = useI18n()

// Keep in step with the transition times in the styles below.
const FADE_OUT = 120
const OPEN = 220

const narrow = ref(collapsed.value)
const quiet = ref(collapsed.value)
const logoFailed = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

watch(collapsed, (next) => {
  clearTimeout(timer)
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (next) {
    quiet.value = true
    timer = setTimeout(() => (narrow.value = true), reduced ? 0 : FADE_OUT)
  } else {
    narrow.value = false
    timer = setTimeout(() => (quiet.value = false), reduced ? 0 : OPEN)
  }
})
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <aside class="side" :class="{ narrow, quiet }">
    <div class="brand">
      <img v-if="!logoFailed" src="/logo.png" alt="" class="brand-logo" @error="logoFailed = true">
      <span class="brand-name" data-fade>Mushin.js <span class="brand-kanji">無心</span></span>
    </div>

    <nav class="nav" :aria-label="t('layout.mainNav')">
      <div v-for="group in groups" :key="group.key" class="group">
        <div v-if="group.label" class="group-title">
          <span data-fade>{{ group.label }}</span>
          <i class="divider" aria-hidden="true" />
        </div>
        <Tooltip v-for="item in group.items" :key="item.key" placement="right" :disabled="!collapsed" :show-arrow="false">
          <template #trigger>
            <RouterLink :to="item.key" class="item" :class="{ on: active === item.key }" :aria-current="active === item.key ? 'page' : undefined" :aria-label="collapsed ? item.label : undefined">
              <span class="item-icon" :class="item.icon" />
              <span class="item-label" data-fade>{{ item.label }}</span>
            </RouterLink>
          </template>
          {{ item.label }}
        </Tooltip>
      </div>
    </nav>

    <div class="foot">
      <Tooltip placement="right" :disabled="!collapsed" :show-arrow="false">
        <template #trigger>
          <button type="button" class="toggle" :aria-label="collapsed ? t('layout.expand') : t('layout.collapse')" :aria-expanded="!collapsed" @click="collapsed = !collapsed">
            <span class="i-lucide-chevron-left toggle-icon" />
          </button>
        </template>
        {{ t('layout.expand') }}
      </Tooltip>
    </div>
  </aside>
</template>

<style scoped>
/*
 * Geometry that does not change between the two states: the icons sit 23px from the left edge
 * (centred in the 64px rail), rows keep their height, and group titles keep theirs as a divider.
 */
.side {
  --side-ease: cubic-bezier(0.4, 0, 0.2, 1);
  flex: none;
  display: flex;
  flex-direction: column;
  width: 224px;
  height: 100%;
  overflow: hidden;
  background: var(--s1);
  border-right: 1px solid var(--line);
  transition: width 0.26s var(--side-ease);
}

.side.narrow {
  width: 64px;
}

/* Words: fade in with a short slide; fade out quicker, then leave the layout's hit testing. */
[data-fade] {
  transition: opacity 0.18s ease-out, transform 0.18s ease-out, visibility 0s;
}

.side.quiet [data-fade] {
  opacity: 0;
  transform: translateX(-6px);
  visibility: hidden;
  transition: opacity 0.12s ease-in, transform 0.12s ease-in, visibility 0s 0.12s;
}

.brand {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 56px;
  padding-left: 18px;
  white-space: nowrap;
}

.brand-logo {
  width: 28px;
  height: 28px;
  flex: none;
}

.brand-name {
  font-weight: 650;
  font-size: 15px;
}

.brand-kanji {
  font-weight: 400;
  color: var(--fg3);
  margin-left: 2px;
}

.nav {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 4px 8px 8px;
}

.group + .group {
  margin-top: 6px;
}

.group-title {
  position: relative;
  height: 30px;
  display: flex;
  align-items: flex-end;
  padding: 0 0 6px 15px;
  font-size: 12px;
  letter-spacing: 0.06em;
  color: var(--fg3);
  white-space: nowrap;
}

/* In the rail a group title becomes a short line under the icons. */
.divider {
  position: absolute;
  left: 12px;
  width: 24px;
  bottom: 12px;
  height: 1px;
  background: var(--line);
  opacity: 0;
  transform: scaleX(0.3);
  transition: opacity 0.12s, transform 0.12s;
}

.side.narrow .divider {
  opacity: 1;
  transform: none;
  transition: opacity 0.2s 0.1s, transform 0.2s 0.1s var(--side-ease);
}

.item {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 38px;
  padding-left: 15px;
  margin-bottom: 2px;
  border-radius: 8px;
  color: var(--fg2);
  white-space: nowrap;
  overflow: hidden;
  text-decoration: none;
  transition: background-color 0.15s, color 0.15s;
}

.item:hover {
  background: var(--s2);
  color: var(--fg);
  text-decoration: none;
}

.item.on {
  background: var(--primary-soft);
  color: var(--primary);
  font-weight: 600;
}

.item:focus-visible,
.toggle:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}

.item-icon {
  flex: none;
  font-size: 18px;
}

.toggle-icon {
  font-size: 16px;
  transition: transform 0.26s var(--side-ease);
}

.side.narrow .toggle-icon {
  transform: rotate(180deg);
}

.foot {
  position: relative;
  flex: none;
  height: 48px;
  border-top: 1px solid var(--line);
}

/* Anchored to the right edge, so it slides with the panel and ends up centred in the rail. */
.toggle {
  position: absolute;
  right: 16px;
  top: 10px;
  width: 32px;
  height: 28px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--fg2);
  cursor: pointer;
}

.toggle:hover {
  background: var(--s2);
  color: var(--fg);
}

@media (prefers-reduced-motion: reduce) {
  .side,
  [data-fade],
  .side.quiet [data-fade],
  .divider,
  .side.narrow .divider,
  .toggle-icon {
    transition: none;
  }
}
</style>
