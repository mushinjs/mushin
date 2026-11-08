/**
 * Brand icons for provider presets, keyed by `type:preset`. They come from @iconify/json through
 * UnoCSS, which ships only the icons named here. `simple-icons` and `ri` icons are one color and
 * follow the text color, so they suit both themes; `logos` icons keep their brand colors and are
 * used only where those colors read on light and dark backgrounds. Presets without an icon show
 * their initial instead, as does Groq, whose only icon is a wide wordmark that is unreadable at tile size.
 *
 * Licenses: simple-icons and logos are CC0-1.0, ri (Remix Icon) is Apache-2.0, hugeicons is MIT.
 * Class names are written out in full so UnoCSS finds them.
 */
const icons: Record<string, string> = {
  'openai:openai': 'i-simple-icons-openai',
  'openai:deepseek': 'i-logos-deepseek-icon',
  'openai:moonshot': 'i-simple-icons-moonshotai',
  'openai:qwen': 'i-logos-qwen-icon',
  'openai:openrouter': 'i-simple-icons-openrouter',
  'openai:zhipu': 'i-ri-zhipu-ai-fill',
  'openai:volcengine-ark': 'i-simple-icons-bytedance',
  'openai:qianfan': 'i-simple-icons-baidu',
  'openai:hunyuan': 'i-simple-icons-tencenthy',
  'openai:minimax': 'i-logos-minimax-icon',
  'openai:xai': 'i-hugeicons-grok',
  'openai:mistral': 'i-logos-mistral-ai-icon',
  'openai:gemini-openai': 'i-logos-google-gemini-icon',
  'openai:together': 'i-logos-togetherai-icon',
  'openai:ollama': 'i-simple-icons-ollama',
  'openai:lmstudio': 'i-simple-icons-lmstudio',
  'openai:vllm': 'i-simple-icons-vllm',
  'azure-openai:azure-openai': 'i-logos-azure-icon',
  'anthropic:anthropic': 'i-simple-icons-anthropic',
  'anthropic:deepseek-anthropic': 'i-logos-deepseek-icon',
  'anthropic:moonshot-anthropic': 'i-simple-icons-moonshotai',
  'anthropic:zhipu-anthropic': 'i-ri-zhipu-ai-fill',
  'anthropic:minimax-anthropic': 'i-logos-minimax-icon',
  'gemini:gemini': 'i-logos-google-gemini-icon',
  'typesafe:typesafe-openrouter': 'i-simple-icons-openrouter',
}

export function presetIcon(type: string, preset: string): string | undefined {
  return icons[`${type}:${preset}`]
}

const colors = ['#5B6CE0', '#2F9E77', '#C46A2B', '#B84C8C', '#3B8FC4', '#8A63D2', '#B5962A', '#D0574F']

/** A stable color for a letter avatar. */
export function avatarColor(seed: string) {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return colors[hash % colors.length]
}
