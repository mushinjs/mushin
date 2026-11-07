/** How the selected node is wired: its inputs, its exits, its outputs and who reads them. */
import { computed } from 'vue'
import { portsOf, refOf, refsIn, splitName } from '../../../flow'
import { useEditor } from './editor'

// Literal braces cannot go in i18n messages or template expressions, so the examples are passed in.
export const refExamples = { open: '{{', node: refOf('n1', 'text'), sys: refOf('sys', 'user'), chat: refOf('chat', 'name') }

export function useNodeWiring() {
  const { nodes, edges, selected, selectedInfo, nodeName, updateSelected } = useEditor()

  /** Where the selected node's values come from and go, for the inputs / outputs tab. */
  const wiring = computed(() => {
    const node = selected.value
    const info = selectedInfo.value
    if (!node || !info) return undefined
    const ports = portsOf(info, node.data!.config)
    const readers = (port: string) => nodes.value
      .filter((item) => refsIn(JSON.stringify([item.data!.config, item.data!.inputs ?? {}])).some((ref) => ref.head === node.id && splitName(ref.name).first === port))
      .map((item) => nodeName(item.id))
    return {
      inputs: ports.inputs.map((port) => ({ port, binding: node.data!.inputs?.[port.name] ?? '' })),
      outputs: ports.outputs.map((port) => ({ port, ref: refOf(node.id, port.name), readers: readers(port.name) })),
      exec: ports.execOut.map((name) => ({
        name,
        to: edges.value.filter((item) => item.source === node.id && item.sourceHandle === `exec:${name}`).map((item) => nodeName(item.target)),
      })),
    }
  })

  function setInput(port: string, value: string) {
    const inputs = { ...selected.value?.data!.inputs }
    if (value) inputs[port] = value
    else delete inputs[port]
    updateSelected({ inputs })
  }

  return { wiring, setInput }
}
