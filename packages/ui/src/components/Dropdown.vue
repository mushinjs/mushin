<script setup lang="ts">
/**
 * A menu opened from its trigger (the default slot). Options take the shape Naive UI used:
 * `{ label, key, icon?, disabled?, danger? }`, `{ type: 'divider' }` and
 * `{ type: 'group', label, children }`. Choosing one emits `select` with its key.
 */
import {
  DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger,
} from 'reka-ui'

export interface DropdownOption {
  key?: string | number
  label?: string
  icon?: string
  disabled?: boolean
  danger?: boolean
  type?: 'divider' | 'group'
  children?: DropdownOption[]
  /** A line of muted text under the label. */
  description?: string
}

// Classes and styles go to the menu panel.
defineOptions({ inheritAttrs: false })

withDefaults(defineProps<{
  options: DropdownOption[]
  placement?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  show?: boolean
  disabled?: boolean
}>(), { placement: 'bottom', align: 'start', show: undefined })

const emit = defineEmits<{ select: [key: any, option: DropdownOption]; 'update:show': [value: boolean] }>()
</script>

<template>
  <DropdownMenuRoot :open="show" @update:open="(value) => emit('update:show', value)">
    <DropdownMenuTrigger as-child :disabled="disabled">
      <slot />
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent v-bind="$attrs" class="mu-pop mu-menu" :side="placement" :align="align" :side-offset="4" :collision-padding="8">
        <template v-for="(option, index) in options" :key="option.key ?? `i${index}`">
          <DropdownMenuSeparator v-if="option.type === 'divider'" class="mu-menu__sep" />
          <template v-else-if="option.type === 'group'">
            <DropdownMenuLabel class="mu-menu__label">{{ option.label }}</DropdownMenuLabel>
            <DropdownMenuItem
              v-for="child in option.children"
              :key="child.key"
              class="mu-menu__item"
              :class="{ 'is-danger': child.danger }"
              :disabled="child.disabled"
              @select="emit('select', child.key, child)"
            >
              <span v-if="child.icon" class="mu-menu__icon" :class="child.icon" />
              <span class="mu-menu__text">{{ child.label }}<small v-if="child.description">{{ child.description }}</small></span>
            </DropdownMenuItem>
          </template>
          <DropdownMenuItem
            v-else
            class="mu-menu__item"
            :class="{ 'is-danger': option.danger }"
            :disabled="option.disabled"
            @select="emit('select', option.key, option)"
          >
            <span v-if="option.icon" class="mu-menu__icon" :class="option.icon" />
            <span class="mu-menu__text">{{ option.label }}<small v-if="option.description">{{ option.description }}</small></span>
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<style>
.mu-menu {
  min-width: 160px;
  max-height: min(420px, var(--reka-dropdown-menu-content-available-height, 420px));
  overflow-y: auto;
  padding: 4px;
}

.mu-menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 4px 10px;
  border-radius: 5px;
  color: var(--fg);
  font-size: 13.5px;
  cursor: pointer;
  outline: none;
  user-select: none;
}

.mu-menu__item[data-highlighted] { background: var(--s2); }
.mu-menu__item[data-disabled] { opacity: 0.45; cursor: not-allowed; }
.mu-menu__item.is-danger { color: var(--bad); }
.mu-menu__item.is-danger[data-highlighted] { background: var(--bad-soft); }
.mu-menu__icon { color: var(--fg2); font-size: 15px; }
.mu-menu__item.is-danger .mu-menu__icon { color: inherit; }
.mu-menu__text { display: flex; flex-direction: column; min-width: 0; }
.mu-menu__text small { color: var(--fg3); font-size: 12px; line-height: 1.4; }
.mu-menu__sep { height: 1px; margin: 4px 2px; background: var(--line); }
.mu-menu__label { padding: 6px 10px 2px; color: var(--fg3); font-size: 12px; font-weight: 500; }
</style>
