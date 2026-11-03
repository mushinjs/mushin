<script setup lang="ts">
/**
 * The sidebar. Collapsing only narrows it: every icon, group and the footer keep their place, so
 * nothing jumps. Labels and group titles fade out before the width closes, and fade back in after
 * it opens. GSAP drives the timeline so the two halves stay in step and can be reversed midway.
 */
import { ChevronBackOutline } from '@vicons/ionicons5'
import { gsap } from 'gsap'
import { NIcon, NTooltip } from 'naive-ui'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { connection } from '../api'

import type { NavGroup } from './nav'

const props = defineProps<{ groups: NavGroup[], active: string }>()
const collapsed = defineModel<boolean>('collapsed', { required: true })
const { t } = useI18n()

const EXPANDED = 224
const COLLAPSED = 64
// Set once: after the first render GSAP owns the width, and Vue must not snap it to the end value.
const initialWidth = `${collapsed.value ? COLLAPSED : EXPANDED}px`

const root = ref<HTMLElement>()
const logoFailed = ref(false)
let ctx: gsap.Context | undefined
let timeline: gsap.core.Timeline | undefined
let reduced = false

/** Everything that fades: item labels, the brand name, group titles and the footer text. */
const fading = () => root.value!.querySelectorAll<HTMLElement>('[data-fade]')

function apply(next: boolean, animate: boolean) {
  const el = root.value
  if (!el || !ctx) return
  ctx.add(() => {
    timeline?.kill()
    const labels = fading()
    const dividers = el.querySelectorAll<HTMLElement>('[data-divider]')
    const chevron = el.querySelector<HTMLElement>('[data-chevron]')
    const width = next ? COLLAPSED : EXPANDED
    if (!animate || reduced) {
      gsap.set(el, { width })
      gsap.set(labels, { autoAlpha: next ? 0 : 1, x: 0 })
      gsap.set(dividers, { autoAlpha: next ? 1 : 0, scaleX: 1 })
      gsap.set(chevron, { rotation: next ? 180 : 0 })
      return
    }
    timeline = gsap.timeline({ defaults: { overwrite: 'auto' } })
    if (next) {
      // Closing: the words leave first, then the panel narrows under the icons.
      timeline
        .to(labels, { autoAlpha: 0, x: -6, duration: 0.16, ease: 'power1.in', stagger: 0.008 })
        .to(el, { width, duration: 0.42, ease: 'power2.inOut' }, 0.06)
        .fromTo(dividers, { autoAlpha: 0, scaleX: 0.3 }, { autoAlpha: 1, scaleX: 1, duration: 0.24, ease: 'power2.out' }, 0.24)
        .to(chevron, { rotation: 180, duration: 0.42, ease: 'power2.inOut' }, 0.06)
    } else {
      // Opening: the panel widens, and the words follow it in.
      timeline
        .to(dividers, { autoAlpha: 0, duration: 0.12, ease: 'power1.in' })
        // A gentle ease over a longer span: the panel should not outrun the words that follow it.
        .to(el, { width, duration: 0.56, ease: 'power2.inOut' }, 0)
        .fromTo(labels, { autoAlpha: 0, x: -8 }, { autoAlpha: 1, x: 0, duration: 0.3, ease: 'power2.out', stagger: 0.014 }, 0.24)
        .to(chevron, { rotation: 0, duration: 0.56, ease: 'power2.inOut' }, 0)
    }
  })
}

onMounted(() => {
  ctx = gsap.context(() => {}, root.value)
  reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  apply(collapsed.value, false)
})
onBeforeUnmount(() => ctx?.revert())

watch(collapsed, (next) => apply(next, true))
// Pages added or hidden while collapsed must start out hidden as well.
watch(() => props.groups, () => requestAnimationFrame(() => apply(collapsed.value, false)), { deep: true, flush: 'post' })
</script>

<template>
  <aside ref="root" class="side" :class="{ collapsed }" :style="{ width: initialWidth }">
    <div class="brand">
      <img v-if="!logoFailed" src="/logo.png" alt="" class="brand-logo" @error="logoFailed = true">
      <span class="brand-name" data-fade>Mushin.js <span class="brand-kanji">無心</span></span>
    </div>

    <nav class="nav" :aria-label="t('layout.mainNav')">
      <div v-for="group in groups" :key="group.key" class="group">
        <div v-if="group.label" class="group-title">
          <span data-fade>{{ group.label }}</span>
          <i class="divider" data-divider aria-hidden="true" />
        </div>
        <NTooltip v-for="item in group.items" :key="item.key" placement="right" :disabled="!collapsed" :show-arrow="false">
          <template #trigger>
            <RouterLink :to="item.key" class="item" :class="{ on: active === item.key }" :aria-current="active === item.key ? 'page' : undefined" :aria-label="collapsed ? item.label : undefined">
              <NIcon :size="18" class="item-icon"><component :is="item.icon" /></NIcon>
              <span class="item-label" data-fade>{{ item.label }}</span>
            </RouterLink>
          </template>
          {{ item.label }}
        </NTooltip>
      </div>
    </nav>

    <div class="foot">
      <span class="link-state" :class="{ off: !connection.connected }" data-fade>
        <span class="dot" />
        {{ connection.connected ? t('layout.connected') : t('layout.reconnecting') }}
      </span>
      <NTooltip placement="right" :disabled="!collapsed" :show-arrow="false">
        <template #trigger>
          <button type="button" class="toggle" :aria-label="collapsed ? t('layout.expand') : t('layout.collapse')" :aria-expanded="!collapsed" @click="collapsed = !collapsed">
            <NIcon :size="16" data-chevron><ChevronBackOutline /></NIcon>
          </button>
        </template>
        {{ t('layout.expand') }}
      </NTooltip>
    </div>
  </aside>
</template>

<style scoped>
/*
 * Geometry that does not change between the two states: the icons sit 23px from the left edge
 * (centred in the 64px rail), rows keep their height, and group titles keep theirs as a divider.
 */
.side {
  flex: none;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--s1);
  border-right: 1px solid var(--line);
  will-change: width;
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

.divider {
  position: absolute;
  left: 12px;
  width: 24px;
  bottom: 12px;
  height: 1px;
  background: var(--line);
  visibility: hidden;
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
}

.foot {
  position: relative;
  flex: none;
  height: 48px;
  display: flex;
  align-items: center;
  padding-left: 22px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--fg3);
}

.link-state {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--ok);
}

.off .dot {
  background: var(--bad);
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
</style>
