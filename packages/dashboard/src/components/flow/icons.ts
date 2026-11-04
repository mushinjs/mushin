import type { NodeCategory } from '../../types'

const byType: Record<string, string> = {
  'trigger.message': 'i-lucide-messages-square',
  'trigger.keyword': 'i-lucide-terminal',
  'trigger.regex': 'i-lucide-code',
  'logic.if': 'i-lucide-git-branch',
  'logic.compare': 'i-lucide-git-compare',
  'logic.random': 'i-lucide-shuffle',
  'logic.cooldown': 'i-lucide-timer',
  'logic.delay': 'i-lucide-hourglass',
  'logic.stopRuns': 'i-lucide-circle-stop',
  'data.text': 'i-lucide-type',
  'data.message': 'i-lucide-mail-open',
  'data.getVar': 'i-lucide-database',
  'data.setVar': 'i-lucide-save',
  'data.increment': 'i-lucide-calculator',
  'ai.chat': 'i-lucide-sparkles',
  'ai.classify': 'i-lucide-tags',
  'action.reply': 'i-lucide-message-circle-more',
  'action.send': 'i-lucide-send',
  'trigger.schedule': 'i-lucide-alarm-clock',
  'logic.waitReply': 'i-lucide-clock',
  'onebot.memberJoin': 'i-lucide-user-plus',
  'onebot.memberLeave': 'i-lucide-user-minus',
  'onebot.poke': 'i-lucide-pointer',
  'onebot.recall': 'i-lucide-undo-2',
  'onebot.groupBan': 'i-lucide-volume-x',
  'onebot.groupAdmin': 'i-lucide-shield-half',
  'onebot.groupUpload': 'i-lucide-cloud-upload',
  'onebot.friendAdd': 'i-lucide-users',
  'onebot.friendRequest': 'i-lucide-mail-plus',
  'onebot.groupRequest': 'i-lucide-key-round',
  'onebot.groupChange': 'i-lucide-pencil',
  'onebot.honor': 'i-lucide-medal',
  'onebot.event': 'i-lucide-bell',
  'onebot.mute': 'i-lucide-volume-x',
  'onebot.muteAll': 'i-lucide-ban',
  'onebot.kick': 'i-lucide-user-minus',
  'onebot.setAdmin': 'i-lucide-shield-check',
  'onebot.setCard': 'i-lucide-id-card',
  'onebot.setTitle': 'i-lucide-award',
  'onebot.setGroupName': 'i-lucide-tag',
  'onebot.groupNotice': 'i-lucide-megaphone',
  'onebot.essence': 'i-lucide-star',
  'onebot.groupSign': 'i-lucide-check-check',
  'onebot.leaveGroup': 'i-lucide-log-out',
  'onebot.deleteMsg': 'i-lucide-trash',
  'onebot.getMsg': 'i-lucide-file-text',
  'onebot.forward': 'i-lucide-grid-2x2',
  'onebot.sendPoke': 'i-lucide-fingerprint',
  'onebot.emojiLike': 'i-lucide-smile',
  'onebot.like': 'i-lucide-thumbs-up',
  'onebot.handleRequest': 'i-lucide-message-circle',
  'onebot.memberInfo': 'i-lucide-user',
  'onebot.userInfo': 'i-lucide-info',
  'onebot.groupInfo': 'i-lucide-users',
  'onebot.senderRole': 'i-lucide-shield-half',
  'onebot.call': 'i-lucide-code-xml',
}

const byCategory: Record<NodeCategory, string> = {
  trigger: 'i-lucide-zap',
  event: 'i-lucide-bell',
  logic: 'i-lucide-network',
  data: 'i-lucide-box',
  ai: 'i-lucide-sparkles',
  action: 'i-lucide-send',
  manage: 'i-lucide-shield-half',
  platform: 'i-lucide-code-xml',
}

/**
 * A node type's icon as a class name. Node types from other plugins fall back to their category's
 * icon. The class names are written out in full above so UnoCSS finds them.
 */
export function nodeIcon(type: string, category?: NodeCategory) {
  return byType[type] ?? (category ? byCategory[category] : 'i-lucide-box')
}
