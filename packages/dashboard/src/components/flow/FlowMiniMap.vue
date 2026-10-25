<script setup lang="ts">
import { type GraphNode, useVueFlow } from '@vue-flow/core'
import { computed, ref } from 'vue'

/**
 * An overview of the whole canvas. It shows the canvas extent (the nodes plus some room around
 * them), so the bright window is simply the part on screen and keeps its size while panning.
 * Click or drag on it to move the view.
 */
const props = defineProps<{
  /** The canvas area, in flow coordinates: [[left, top], [right, bottom]]. */
  extent: [[number, number], [number, number]]
  nodeColor(node: GraphNode): string
  dark: boolean
}>()

const { viewport, dimensions, getNodes, setViewport } = useVueFlow('flow-editor')

const WIDTH = 200
const HEIGHT = 140
const svg = ref<SVGSVGElement>()

const visible = computed(() => {
  const zoom = viewport.value.zoom || 1
  return {
    x: -viewport.value.x / zoom,
    y: -viewport.value.y / zoom,
    width: dimensions.value.width / zoom,
    height: dimensions.value.height / zoom,
  }
})

const boxes = computed(() => getNodes.value
  .filter((node) => !node.hidden)
  .map((node) => ({
    id: node.id,
    x: node.computedPosition.x,
    y: node.computedPosition.y,
    width: node.dimensions.width || 240,
    height: node.dimensions.height || 80,
    color: props.nodeColor(node),
  })))

/**
 * What the minimap shows: the canvas extent, centered. Where the screen is wider or taller than
 * the canvas (common for a short, wide flow), that side grows to the screen's size, still
 * centered on the canvas, so the area depends only on the zoom and never on where the view is.
 */
const area = computed(() => {
  const [[x0, y0], [x1, y1]] = props.extent
  const v = visible.value
  const width = Math.max(1, x1 - x0, v.width)
  const height = Math.max(1, y1 - y0, v.height)
  return { x: (x0 + x1) / 2 - width / 2, y: (y0 + y1) / 2 - height / 2, width, height }
})

/** The dimmed area: the whole extent with the visible window cut out. */
const mask = computed(() => {
  const a = area.value
  const v = visible.value
  const pad = Math.max(a.width, a.height)
  return `M${a.x - pad},${a.y - pad}h${a.width + pad * 2}v${a.height + pad * 2}h${-(a.width + pad * 2)}z`
    + `M${v.x},${v.y}h${v.width}v${v.height}h${-v.width}z`
})

/** Centers the view on the point under the pointer, keeping the zoom. */
function moveTo(event: PointerEvent) {
  const matrix = svg.value?.getScreenCTM()
  if (!matrix) return
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
  const zoom = viewport.value.zoom || 1
  setViewport({
    x: -(point.x - visible.value.width / 2) * zoom,
    y: -(point.y - visible.value.height / 2) * zoom,
    zoom,
  })
}

let dragging = false
function onDown(event: PointerEvent) {
  dragging = true
  ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
  moveTo(event)
}
function onMove(event: PointerEvent) {
  if (dragging) moveTo(event)
}
function onUp() {
  dragging = false
}
</script>

<template>
  <div class="flow-minimap nodrag nowheel" :class="{ dark }">
    <svg
      ref="svg"
      :width="WIDTH"
      :height="HEIGHT"
      :viewBox="`${area.x} ${area.y} ${area.width} ${area.height}`"
      preserveAspectRatio="xMidYMid meet"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    >
      <rect :x="area.x" :y="area.y" :width="area.width" :height="area.height" class="extent" />
      <rect
        v-for="box in boxes"
        :key="box.id"
        :x="box.x"
        :y="box.y"
        :width="box.width"
        :height="box.height"
        :rx="Math.min(box.width, box.height) * 0.12"
        :fill="box.color"
      />
      <path :d="mask" fill-rule="evenodd" class="mask" />
      <rect :x="visible.x" :y="visible.y" :width="visible.width" :height="visible.height" class="window" vector-effect="non-scaling-stroke" />
    </svg>
  </div>
</template>

<style scoped>
.flow-minimap {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 5;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  cursor: grab;
  touch-action: none;
}

.flow-minimap.dark {
  background: #1d1d22;
}

.flow-minimap:active {
  cursor: grabbing;
}

svg {
  display: block;
}

.extent {
  fill: rgba(127, 127, 127, 0.06);
}

.mask {
  fill: rgba(240, 240, 240, 0.65);
}

.dark .mask {
  fill: rgba(18, 18, 22, 0.65);
}

.window {
  fill: none;
  stroke: #2080f0;
  stroke-width: 1.5;
}
</style>
