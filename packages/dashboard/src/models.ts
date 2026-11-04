import type { SelectGroup, SelectOption } from '@mushin/ui'
import type { ModelProfile, Provider } from './types'

export type Capability = 'vision' | 'reasoning' | 'tools' | 'code' | 'embedding' | 'rerank' | 'image' | 'audio'

export const CAPABILITY_ICONS: Record<Capability, string> = {
  vision: 'i-lucide-eye',
  reasoning: 'i-lucide-lightbulb',
  tools: 'i-lucide-wrench',
  code: 'i-lucide-code',
  embedding: 'i-lucide-layers',
  rerank: 'i-lucide-git-compare',
  image: 'i-lucide-image',
  audio: 'i-lucide-mic',
}

const has = (name: string, pattern: RegExp) => pattern.test(name)

/**
 * What a model can do, guessed from its name, since provider model lists rarely say. Covers the
 * common naming of OpenAI, Anthropic, Gemini, DeepSeek, Qwen, GLM, Kimi and similar families.
 */
export function modelCapabilities(model: string): Capability[] {
  const name = model.toLowerCase()
  if (has(name, /rerank/)) return ['rerank']
  if (has(name, /embed|bge-(?!reranker)|^text-embedding|\bm3e\b/)) return ['embedding']
  if (has(name, /(^|[/-])(tts|asr|whisper|cosyvoice|sensevoice|moss-ttsd)|voice|speech|audio|-asr|asr-/)) return ['audio']
  if (has(name, /dall-e|gpt-image|stable-diffusion|sdxl|flux|kolors|qwen-image|z-image|wan\d|wanx|-t2v|-i2v|imagen|seedream|cogview/)) return ['image']
  if (has(name, /captioner/)) return ['vision']
  const caps: Capability[] = []
  if (has(name, /vision|[-/.]vl\b|-vl-|vl-|omni|gpt-4o|gpt-4\.1|gpt-[5-9]|claude|gemini|glm-\d+(\.\d+)?v\b|glm-4v|glm-4\.\dv|qvq|llava|pixtral|internvl|minicpm-v|-ocr|ocr-|kimi-k2\.[5-9]|kimi-vl|grok-.*vision|step-.*v|doubao.*vision|\bvision\b/)) caps.push('vision')
  if (has(name, /think|reason|r1\b|-r1|qwq|qvq|(^|[/-])o[1-9](\b|-)|gpt-[5-9]|claude-(opus|sonnet)-(4|[5-9])|claude-3-7|gemini-(2\.5|[3-9])|deepseek-v3\.[1-9]|deepseek-v[4-9]|glm-z1|glm-4\.[5-9]|glm-[5-9]|kimi-k2|qwen3(?!.*instruct)|hunyuan-t|-thinking|reasoner/)) caps.push('reasoning')
  if (has(name, /coder|codex|code\b|-code-|devstral|codestral/)) caps.push('code')
  if (!has(name, /ocr|captioner|mt-|-mt\b|translat/) && has(name, /gpt|(^|[/-])o[1-9](\b|-)|claude|gemini|deepseek|qwen|glm-[4-9]|kimi|moonshot|mistral|hunyuan|doubao|step-|ling-|longcat|seed-oss|grok|llama-3\.[1-9]|llama-[4-9]|command-r/)) caps.push('tools')
  return caps
}

/** Options for a model select: the given models with capability icons. */
export function modelOptions(models: string[]): SelectOption[] {
  return models.map((model) => ({ label: model, value: model }))
}

export const isProfile = (profiles: ModelProfile[], id?: string | null) => !!id && profiles.some((profile) => profile.id === id)

/** A heading in a provider select; also accepted by the Naive UI selects not yet moved over. */
type ChoiceGroup = SelectGroup & Record<string, unknown>

/** Providers and, unless left out, profiles under their own headings, for every provider select. */
export function providerOptions(
  providers: Provider[],
  profiles: ModelProfile[],
  t: (key: string) => string,
  options: { profiles?: boolean; markDefault?: boolean } = {},
): (SelectOption | ChoiceGroup)[] {
  const list = providers.map((provider) => ({
    label: options.markDefault && provider.isDefault ? `${provider.name} (${t('common.default')})` : provider.name,
    value: provider.id,
  }))
  if (options.profiles === false || !profiles.length) return list
  return [
    { type: 'group' as const, label: t('choiceGroups.providers'), key: 'providers', children: list },
    { type: 'group' as const, label: t('choiceGroups.profiles'), key: 'profiles', children: profiles.map((profile) => ({ label: profile.name, value: profile.id })) },
  ]
}

/** "Name: model" for one model of a profile. */
export function profileModelLabel(providers: Provider[], item: { provider: string; model: string }) {
  const provider = providers.find((entry) => entry.id === item.provider)
  return `${provider?.name ?? item.provider} / ${item.model}`
}
