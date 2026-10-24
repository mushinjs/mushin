import {
  CalculatorOutline, ChatbubbleEllipsesOutline, ChatbubblesOutline, CodeSlashOutline, CubeOutline, FlashOutline,
  GitBranchOutline, GitCompareOutline, GitNetworkOutline, HourglassOutline, MailOpenOutline, PricetagsOutline,
  SaveOutline, SendOutline, ServerOutline, ShuffleOutline, SparklesOutline, StopwatchOutline, TerminalOutline, TextOutline,
} from '@vicons/ionicons5'
import type { Component } from 'vue'
import type { NodeCategory } from '../../types'

const byType: Record<string, Component> = {
  'trigger.message': ChatbubblesOutline,
  'trigger.keyword': TerminalOutline,
  'trigger.regex': CodeSlashOutline,
  'logic.if': GitBranchOutline,
  'logic.compare': GitCompareOutline,
  'logic.random': ShuffleOutline,
  'logic.cooldown': StopwatchOutline,
  'logic.delay': HourglassOutline,
  'data.text': TextOutline,
  'data.message': MailOpenOutline,
  'data.getVar': ServerOutline,
  'data.setVar': SaveOutline,
  'data.increment': CalculatorOutline,
  'ai.chat': SparklesOutline,
  'ai.classify': PricetagsOutline,
  'action.reply': ChatbubbleEllipsesOutline,
}

const byCategory: Record<NodeCategory, Component> = {
  trigger: FlashOutline,
  logic: GitNetworkOutline,
  data: CubeOutline,
  ai: SparklesOutline,
  action: SendOutline,
}

/** Node types from other plugins fall back to their category's icon. */
export function nodeIcon(type: string, category?: NodeCategory) {
  return byType[type] ?? (category ? byCategory[category] : CubeOutline)
}
