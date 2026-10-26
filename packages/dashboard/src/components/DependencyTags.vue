<script setup lang="ts">
import { NButton, NTag, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CatalogEntry, DependencyState, PluginDependencies } from '../types'
import { localize } from '../utils'

/** A plugin's dependencies as tags: what it needs (red when missing), what it works better with, what needs it. */
const props = defineProps<{ deps?: PluginDependencies; catalog: CatalogEntry[]; showDependents?: boolean }>()
const emit = defineEmits<{ enableDeps: [] }>()
const { t, locale } = useI18n()

const nameOf = (pkg: string) => localize(props.catalog.find((entry) => entry.package === pkg)?.manifest.displayName, locale.value) || pkg

function problemText(dep: DependencyState) {
  switch (dep.problem) {
    case 'not-installed': return t('plugins.notInstalled')
    case 'version': return t('plugins.wrongVersion', { range: dep.range, version: dep.version ?? '?' })
    case 'disabled': return t('plugins.notEnabled')
    default: return ''
  }
}

const requires = computed(() => (props.deps?.requires ?? []).filter((dep) => dep.problem !== 'not-app' || dep.kind !== 'bot'))
const fixable = computed(() => requires.value.some((dep) => dep.problem === 'disabled'))
const dependents = computed(() => (props.showDependents ? props.deps?.dependents ?? [] : []).filter((dep) => !dep.optional))
</script>

<template>
  <div v-if="requires.length || deps?.optional.length || dependents.length || deps?.mushin" class="deps">
    <div v-if="deps?.mushin && !deps.mushin.ok" class="row">
      <NTag size="small" type="error" :bordered="false">{{ t('plugins.mushinVersion', { range: deps.mushin.range, version: deps.mushin.version }) }}</NTag>
    </div>
    <div v-if="requires.length" class="row">
      <span class="label">{{ t('plugins.requires') }}</span>
      <NTooltip v-for="dep in requires" :key="dep.package" :disabled="!dep.problem">
        <template #trigger>
          <NTag size="small" :type="dep.problem ? 'error' : 'default'" :bordered="false">
            {{ nameOf(dep.package) }}<template v-if="dep.problem">（{{ problemText(dep) }}）</template>
          </NTag>
        </template>
        <span class="mono">{{ dep.package }}@{{ dep.range }}</span>
      </NTooltip>
      <NButton v-if="fixable" size="tiny" type="primary" secondary @click="emit('enableDeps')">{{ t('plugins.enableDeps') }}</NButton>
    </div>
    <div v-if="deps?.optional.length" class="row">
      <span class="label">{{ t('plugins.optionalDeps') }}</span>
      <NTag v-for="dep in deps.optional" :key="dep.package" size="small" :type="dep.problem ? 'default' : 'info'" :bordered="false" :class="{ faint: !!dep.problem }">
        {{ nameOf(dep.package) }}<template v-if="dep.problem">（{{ problemText(dep) }}）</template>
      </NTag>
    </div>
    <div v-if="dependents.length" class="row">
      <span class="label">{{ t('plugins.dependents') }}</span>
      <NTag v-for="dep in dependents" :key="dep.package" size="small" :bordered="false">{{ nameOf(dep.package) }}</NTag>
    </div>
  </div>
</template>

<style scoped>
.deps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.label {
  font-size: 12px;
  opacity: 0.6;
  margin-right: 2px;
}

.faint {
  opacity: 0.6;
}
</style>
