<script setup lang="ts">
import { GraphChart, type GraphSeriesOption } from 'echarts/charts'
import { LegendComponent, type LegendComponentOption, TooltipComponent, type TooltipComponentOption } from 'echarts/components'
import { type ComposeOption, type ECharts, init, use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useTheme } from '../theme'

use([GraphChart, LegendComponent, TooltipComponent, CanvasRenderer])

type Option = ComposeOption<GraphSeriesOption | LegendComponentOption | TooltipComponentOption>

export interface GraphNode { id: string; group: string; label: string; detail: string }
export interface GraphEdge { source: string; target: string; value: number }

/** A force-laid graph of points joined by weighted lines, coloured by group. */
const props = defineProps<{ nodes: GraphNode[]; edges: GraphEdge[]; height?: number }>()
const emit = defineEmits<{ select: [id: string] }>()
const { isDark } = useTheme()

const el = ref<HTMLDivElement>()
let chart: ECharts | undefined
let observer: ResizeObserver | undefined

const escape = (text: string) => text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)

function option(): Option {
  const groups = [...new Set(props.nodes.map((node) => node.group))]
  const degree = new Map<string, number>()
  for (const edge of props.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }
  return {
    backgroundColor: 'transparent',
    tooltip: {
      confine: true,
      formatter: (params: any) => (params.dataType === 'edge'
        ? `${Math.round(params.data.value * 100)}%`
        : `<div style="max-width:320px;white-space:normal"><b>${escape(params.data.name)}</b><br>${escape(params.data.detail)}</div>`),
    },
    legend: groups.length > 1 && groups.length <= 12 ? { data: groups, type: 'scroll', bottom: 0 } : undefined,
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      categories: groups.map((name) => ({ name })),
      data: props.nodes.map((node) => ({
        id: node.id,
        name: node.label,
        detail: node.detail,
        category: groups.indexOf(node.group),
        symbolSize: 10 + Math.min(16, (degree.get(node.id) ?? 0) * 3),
      })),
      links: props.edges.map((edge) => ({ source: edge.source, target: edge.target, value: edge.value, lineStyle: { width: 0.5 + edge.value * 2, opacity: 0.25 + edge.value * 0.5 } })),
      force: { repulsion: 140, edgeLength: [40, 140], gravity: 0.06 },
      emphasis: { focus: 'adjacency', lineStyle: { width: 3 } },
      lineStyle: { color: 'source', curveness: 0.1 },
      label: { show: props.nodes.length <= 60, position: 'right', fontSize: 11, formatter: (params: any) => String(params.name).slice(0, 12) },
    }],
  }
}

function render() {
  if (!el.value) return
  chart?.dispose()
  chart = init(el.value, isDark.value ? 'dark' : undefined, { renderer: 'canvas' })
  chart.setOption(option())
  chart.on('click', (params: any) => {
    if (params.dataType === 'node') emit('select', params.data.id)
  })
}

onMounted(() => {
  render()
  observer = new ResizeObserver(() => chart?.resize())
  if (el.value) observer.observe(el.value)
})

watch(() => [props.nodes, props.edges], () => chart?.setOption(option(), { notMerge: true }))
watch(isDark, render)

onBeforeUnmount(() => {
  observer?.disconnect()
  chart?.dispose()
})
</script>

<template>
  <div ref="el" class="graph" :style="{ height: `${height ?? 520}px` }" />
</template>

<style scoped>
.graph {
  width: 100%;
}
</style>
