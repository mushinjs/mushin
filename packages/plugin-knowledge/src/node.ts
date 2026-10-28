import { field, z } from '@mushin/core'
import type { NodeType } from '@mushin/plugin-flows'
import type { Knowledge } from './index'
import { passages } from './search'

/**
 * The knowledge search node: finds passages about the message, outputs them as one text for
 * "Ask the LLM", and continues on `empty` when nothing scores high enough, which also tells
 * whether a message is about the base's topic at all.
 */
export function searchNode(knowledge: Knowledge): NodeType {
  return {
    kind: 'action',
    type: 'kb.search',
    category: 'ai',
    title: { en: 'Search knowledge', 'zh-CN': '知识库检索' },
    description: {
      en: 'Finds passages about the question in knowledge bases, by keywords and by meaning. Connect "Passages" to the knowledge input of "Ask the LLM". Continues on "empty" when nothing scores at least the minimum, e.g. to chat normally when a message is off topic.',
      'zh-CN': '在知识库里按关键词和语义查找与问题相关的片段。把“参考资料”接到“询问大模型”的参考资料输入。没有片段达到最低分数时走 empty，可用来判断消息是不是这个话题，不是就走普通闲聊。',
    },
    config: z.object({
      bases: z.array(z.string()).default([]).meta(field('Knowledge bases', 'Empty searches every base', {
        'zh-CN': { title: '知识库', description: '留空搜索全部知识库' },
      }, { choices: 'kb.choices' })),
      topK: z.number().int().min(1).max(20).default(3).meta(field('Passages', 'Most passages to return', {
        'zh-CN': { title: '片段数', description: '最多返回几段' },
      })),
      minScore: z.number().min(0).max(1).default(0.3).meta(field('Minimum score', 'From 0 to 1: the better of meaning similarity and the share of the question\'s words a passage contains', {
        'zh-CN': { title: '最低分数', description: '0 到 1：语义相似度和问题字词覆盖率中较高的那个' },
      })),
    }),
    inputs: [{ name: 'query', type: 'text', title: { en: 'Question (empty: the message)', 'zh-CN': '问题（留空为收到的消息）' } }],
    outputs: [
      { name: 'context', type: 'text', title: { en: 'Passages', 'zh-CN': '参考资料' } },
      { name: 'top', type: 'text', title: { en: 'Best passage', 'zh-CN': '最相关的一段' } },
      { name: 'score', type: 'number', title: { en: 'Best score', 'zh-CN': '最高分数' } },
      { name: 'count', type: 'number', title: { en: 'Passages found', 'zh-CN': '命中数' } },
      { name: 'hits', type: 'any', title: { en: 'Hits', 'zh-CN': '命中列表' } },
    ],
    execOut: ['next', 'empty'],
    async run(context) {
      const { config, inputs, session, signal, logger, run } = context
      const query = String(inputs.query || session.text).trim()
      const bases = (config.bases as string[] | undefined) ?? []
      const result = await knowledge.search({
        query,
        ...(bases.length ? { bases } : {}),
        topK: Number(config.topK ?? 3),
        minScore: Number(config.minScore ?? 0.3),
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      })
      for (const warning of result.warnings) logger.warn(warning)
      const hits = result.hits.map((hit) => ({
        base: hit.baseName, doc: hit.docTitle, title: hit.title, text: hit.text, score: Math.round(hit.score * 1000) / 1000,
        ...(hit.similarity !== undefined ? { similarity: Math.round(hit.similarity * 1000) / 1000 } : {}),
        coverage: Math.round(hit.coverage * 1000) / 1000,
      }))
      // Replies later in the run show which passages they came from.
      run.knowledge = result.hits.map((hit) => ({ base: hit.base, doc: hit.doc, chunk: hit.id, title: hit.title || hit.docTitle }))
      return {
        exec: hits.length ? 'next' : 'empty',
        outputs: {
          context: passages(result.hits),
          top: result.hits[0]?.text ?? '',
          score: hits[0]?.score ?? 0,
          count: hits.length,
          hits,
        },
      }
    },
  }
}
