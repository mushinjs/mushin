import { describe, expect, it } from 'vitest'
import type { ProviderType } from '@mushin/plugin-providers'
import { apply } from '../src'

function definedTypes() {
  const types: ProviderType[] = []
  apply({ llm: { defineType: (type: ProviderType) => types.push(type) } } as any)
  return types
}

describe('OpenAI-compatible presets', () => {
  it('have unique ids and valid base URLs', () => {
    const type = definedTypes().find((item) => item.id === 'openai')!
    const presets = type.presets ?? []
    expect(new Set(presets.map((preset) => preset.id)).size).toBe(presets.length)
    for (const preset of presets) {
      expect(type.config.safeParse(preset.config).success, preset.id).toBe(true)
    }
    expect(presets.map((preset) => preset.id)).toEqual(expect.arrayContaining([
      'zhipu', 'volcengine-ark', 'qianfan', 'hunyuan', 'minimax', 'stepfun', 'xai', 'groq',
      'mistral', 'gemini-openai', 'together', 'lmstudio', 'vllm',
    ]))
  })
})
