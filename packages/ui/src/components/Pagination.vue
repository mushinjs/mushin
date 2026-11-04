<script setup lang="ts">
/** Page buttons for a long list. `page` counts from 1; `pageSizes` adds a picker for the page size. */
import { PaginationEllipsis, PaginationList, PaginationListItem, PaginationNext, PaginationPrev, PaginationRoot } from 'reka-ui'
import { computed } from 'vue'
import { type Size, useText } from '../config'
import Select from './Select.vue'

const props = withDefaults(defineProps<{
  page?: number
  pageSize?: number
  pageSizes?: number[]
  itemCount?: number
  size?: Size
  disabled?: boolean
}>(), { page: 1, pageSize: 10, itemCount: 0, size: 'medium' })

const emit = defineEmits<{ 'update:page': [page: number]; 'update:pageSize': [size: number] }>()
const text = useText()
const sizeOptions = computed(() => (props.pageSizes ?? []).map((size) => ({ value: size, label: text.value.perPage.replace('{n}', String(size)) })))
</script>

<template>
  <div class="mu-pagination-bar">
    <PaginationRoot
      class="mu-pagination"
      :class="`mu-pagination--${size}`"
      :page="page"
      :items-per-page="pageSize"
      :total="itemCount"
      :sibling-count="1"
      :disabled="disabled"
      show-edges
      @update:page="(next) => emit('update:page', next)"
    >
      <PaginationList v-slot="{ items }" class="mu-pagination__list">
        <PaginationPrev class="mu-pagination__item" :aria-label="text.previous"><span class="i-lucide-chevron-left" /></PaginationPrev>
        <template v-for="(item, index) in items" :key="index">
          <PaginationListItem v-if="item.type === 'page'" :value="item.value" class="mu-pagination__item" :class="{ 'is-active': item.value === page }">{{ item.value }}</PaginationListItem>
          <PaginationEllipsis v-else :index="index" class="mu-pagination__ellipsis">…</PaginationEllipsis>
        </template>
        <PaginationNext class="mu-pagination__item" :aria-label="text.next"><span class="i-lucide-chevron-right" /></PaginationNext>
      </PaginationList>
    </PaginationRoot>
    <Select v-if="sizeOptions.length" :value="pageSize" :options="sizeOptions" :size="size" class="mu-pagination__size" :disabled="disabled" @update:value="(next: number) => emit('update:pageSize', next)" />
  </div>
</template>

<style>
.mu-pagination-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.mu-pagination__size { width: 110px; }
.mu-pagination { --h: 30px; }
.mu-pagination--tiny { --h: 22px; }
.mu-pagination--small { --h: 26px; }
.mu-pagination--large { --h: 36px; }

.mu-pagination__list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.mu-pagination__item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: var(--h);
  height: var(--h);
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg2);
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s, border-color 0.15s;
}

.mu-pagination__item:not(:disabled):hover { background: var(--s2); color: var(--fg); }
.mu-pagination__item:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--focus); }
.mu-pagination__item:disabled { opacity: 0.4; cursor: not-allowed; }
.mu-pagination__item.is-active { border-color: var(--primary); color: var(--primary); cursor: default; }
.mu-pagination__item.is-active:hover { background: transparent; color: var(--primary); }
.mu-pagination__item > span { font-size: 15px; }

.mu-pagination__ellipsis {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--h);
  height: var(--h);
  color: var(--fg3);
}
</style>
