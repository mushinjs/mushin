<script setup lang="ts">
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { type ComposeOption, type ECharts, init, use } from 'echarts/core'
import type { LineSeriesOption } from 'echarts/charts'
import type { GridComponentOption, LegendComponentOption, TooltipComponentOption } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useTheme } from '../theme'

// Only line charts are used, so only they are bundled.
use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

export type ChartOption = ComposeOption<LineSeriesOption | GridComponentOption | LegendComponentOption | TooltipComponentOption>

const props = defineProps<{ option: ChartOption; height?: number }>()
const { isDark } = useTheme()

const el = ref<HTMLDivElement>()
let chart: ECharts | undefined
let observer: ResizeObserver | undefined

function render() {
  if (!el.value) return
  chart?.dispose()
  chart = init(el.value, isDark.value ? 'dark' : undefined, { renderer: 'canvas' })
  chart.setOption({ backgroundColor: 'transparent', ...props.option })
}

onMounted(() => {
  render()
  observer = new ResizeObserver(() => chart?.resize())
  if (el.value) observer.observe(el.value)
})

watch(() => props.option, (option) => chart?.setOption(option, { replaceMerge: ['series'] }), { deep: false })
watch(isDark, render)

onBeforeUnmount(() => {
  observer?.disconnect()
  chart?.dispose()
})
</script>

<template>
  <div ref="el" class="chart" :style="{ height: `${height ?? 240}px` }" />
</template>

<style scoped>
.chart {
  width: 100%;
}
</style>
