import { type Context, z } from '@mushinjs/core'
import type { AdapterType } from './types'

const SandboxConfig = z.object({})

/**
 * A bot that connects to no platform: it only answers in its sandbox conversation, so plugins,
 * flows and personas can be tried before a real account is set up. Always "online" while running.
 */
export const sandboxAdapter: AdapterType<z.infer<typeof SandboxConfig>> = {
  id: 'sandbox',
  displayName: { en: 'Sandbox', 'zh-CN': '沙盒' },
  description: { en: 'Try a bot in the dashboard, no account needed', 'zh-CN': '不连接任何平台，在控制台里直接试' },
  icon: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2M6.453 15h11.094M8.5 2h7"/>',
  color: '#8A63D2',
  config: SandboxConfig,
  segments: ['text', 'at', 'image', 'face', 'reply'],
  plugin: {
    name: 'sandbox',
    inject: ['bot'],
    Config: SandboxConfig,
    apply(ctx: Context) {
      ctx.bot.useTransport({
        send: async () => {
          throw new Error('A sandbox bot is not connected to any platform; it only answers in its sandbox conversation')
        },
      })
      ctx.bot.setStatus('online')
    },
  },
  describe: () => ({ mode: 'sandbox' }),
}
