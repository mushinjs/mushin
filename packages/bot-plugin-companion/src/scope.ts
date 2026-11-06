import type { ChannelInfo } from '@mushin/core'
import type { Config } from './config'

/** Whether the companion chats in a channel, by the plugin's group and private settings. */
export function inScope(config: Pick<Config, 'groups' | 'excludeGroups' | 'privateChat'>, channel: Pick<ChannelInfo, 'type' | 'id'>) {
  if (channel.type === 'private') return config.privateChat
  if (config.excludeGroups.includes(channel.id)) return false
  return !config.groups.length || config.groups.includes(channel.id)
}

/** Whether the companion keeps memories of a channel, by the memory settings. */
export function remembers(config: Pick<Config, 'memory' | 'memoryGroups' | 'memoryPrivate'>, channel: Pick<ChannelInfo, 'type' | 'id'>) {
  if (!config.memory) return false
  if (channel.type === 'private') return config.memoryPrivate
  return !config.memoryGroups.length || config.memoryGroups.includes(channel.id)
}
