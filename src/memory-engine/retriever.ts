/**
 * 轻量检索器，镜像 Shiori `memory2/retriever.py` 的核心：
 * 两路独立召回（向量 + 关键词）+ RRF 融合 + 注入规划（forced/norms/events 分区 + 字符预算）。
 * 不引入 HyDE / query-rewriter / sufficiency 等 LLM 重组件。
 */

import type { StoreHit } from './contracts.ts'
import type { RetrievalConfig } from './config.ts'
import { type Embedder } from './llm.ts'
import { type ShioriMemoryStore } from './store.ts'

const RRF_K = 60
const KEYWORD_RRF_WEIGHT = 0.5
const KEYWORD_LIMIT_FLOOR = 30
const KEYWORD_LIMIT_MULTIPLIER = 2
const EMBED_TIMEOUT_MS = 8000

const CJK_STOPWORDS = new Set([
  '用户', '助手', '我们', '他们', '这个', '那个', '什么', '如何', '是否',
  '有没', '没有', '有过', '做过', '进行', '完成', '包括', '通过', '实现',
  '行为', '内容', '相关', '情况', '问题', '方式', '时候', '时间', '目前',
  '当前', '最近', '之前', '以前', '后来', '然后', '因为', '所以', '但是',
  '用户在', '用户对', '的行为吗', '进行了',
])

/** 从查询文本提取关键词（ASCII token + CJK 双字，去停用词），镜像 `_extract_terms`。 */
export function extractTerms(query: string): string[] {
  const terms: string[] = []
  const ascii = query.match(/[a-zA-Z0-9_\-.]{2,}/g) ?? []
  terms.push(...ascii)
  const cjkChunks = query.match(/[\u4e00-\u9fff\u3040-\u30ff]{2,}/g) ?? []
  for (const chunk of cjkChunks) {
    if (chunk.length <= 4) {
      if (!CJK_STOPWORDS.has(chunk)) terms.push(chunk)
      continue
    }
    for (let index = 0; index < chunk.length - 1; index += 1) {
      const bigram = chunk.slice(index, index + 2)
      if (!CJK_STOPWORDS.has(bigram)) terms.push(bigram)
    }
  }
  return [...new Set(terms)].slice(0, 20)
}

export interface RetrieveOptions {
  readonly query: string
  readonly auxQueries?: readonly string[] | undefined
  readonly memoryTypes?: readonly string[] | undefined
  readonly memoryDomains?: readonly string[] | undefined
  readonly topK?: number | undefined
  readonly scoreThreshold?: number | undefined
  readonly roleId?: string | undefined
  readonly scopeChannel?: string | undefined
  readonly scopeChatId?: string | undefined
  readonly requireScopeMatch?: boolean | undefined
  readonly timeStart?: string | undefined
  readonly timeEnd?: string | undefined
  readonly keywordEnabled?: boolean | undefined
  readonly hotnessAlpha?: number | undefined
}

export interface InjectionSection {
  readonly heading: string
  readonly lines: readonly string[]
  readonly injectedIds: readonly string[]
}

export interface InjectionBlock {
  readonly text: string
  readonly injectedIds: readonly string[]
}

export class Retriever {
  constructor(
    private readonly store: ShioriMemoryStore,
    private readonly embedder: Embedder | undefined,
    private readonly config: RetrievalConfig,
  ) {}

  /** 统一检索入口：向量 lane + 关键词 lane + RRF 融合。 */
  async retrieve(options: RetrieveOptions): Promise<StoreHit[]> {
    const topK = Math.max(1, options.topK ?? this.config.topKHistory)
    const threshold = options.scoreThreshold ?? this.config.scoreThreshold

    const queryTexts = dedupeTexts([options.query, ...(options.auxQueries ?? [])])
    const vectorItems = queryTexts.length > 0 && this.embedder !== undefined
      ? await this.retrieveVectorLanes(queryTexts, {
          topK,
          memoryTypes: options.memoryTypes,
          memoryDomains: options.memoryDomains,
          scoreThreshold: threshold,
          roleId: options.roleId,
          scopeChannel: options.scopeChannel,
          scopeChatId: options.scopeChatId,
          requireScopeMatch: options.requireScopeMatch,
          timeStart: options.timeStart,
          timeEnd: options.timeEnd,
          hotnessAlpha: options.hotnessAlpha ?? 0,
        })
      : []

    let keywordItems: StoreHit[] = []
    if (options.keywordEnabled !== false) {
      const terms = extractTerms(options.query)
      if (terms.length > 0) {
        keywordItems = this.store.keywordSearchSummary(terms, {
          memoryTypes: options.memoryTypes,
          memoryDomains: options.memoryDomains,
          roleId: options.roleId,
          scopeChannel: options.scopeChannel,
          scopeChatId: options.scopeChatId,
          requireScopeMatch: options.requireScopeMatch,
          timeStart: options.timeStart,
          timeEnd: options.timeEnd,
          limit: Math.max(KEYWORD_LIMIT_FLOOR, topK * KEYWORD_LIMIT_MULTIPLIER),
        })
      }
    }

    return rrfMerge(vectorItems, keywordItems, topK)
  }

  private async retrieveVectorLanes(
    queryTexts: readonly string[],
    options: {
      topK: number
      memoryTypes?: readonly string[] | undefined
      memoryDomains?: readonly string[] | undefined
      scoreThreshold: number
      roleId?: string | undefined
      scopeChannel?: string | undefined
      scopeChatId?: string | undefined
      requireScopeMatch?: boolean | undefined
      timeStart?: string | undefined
      timeEnd?: string | undefined
      hotnessAlpha: number
    },
  ): Promise<StoreHit[]> {
    const embedder = this.embedder
    if (embedder === undefined) return []
    const vectors: number[][] = []
    for (const text of queryTexts) {
      try {
        vectors.push(await Promise.race([
          embedder.embed(text),
          new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error(`embedding timed out after ${EMBED_TIMEOUT_MS}ms`)),
            EMBED_TIMEOUT_MS,
          )),
        ]))
      } catch {
        // 单路 embed 失败则跳过该 lane，不阻断检索
      }
    }
    if (vectors.length === 0) return []

    const seen = new Map<string, StoreHit>()
    for (const vector of vectors) {
      const hits = this.store.vectorSearch(vector, {
        topK: options.topK,
        memoryTypes: options.memoryTypes,
        memoryDomains: options.memoryDomains,
        scoreThreshold: options.scoreThreshold,
        roleId: options.roleId,
        scopeChannel: options.scopeChannel,
        scopeChatId: options.scopeChatId,
        requireScopeMatch: options.requireScopeMatch,
        timeStart: options.timeStart,
        timeEnd: options.timeEnd,
        hotnessAlpha: options.hotnessAlpha,
      })
      for (const hit of hits) {
        const current = seen.get(hit.id)
        if (current === undefined || (hit.score ?? 0) > (current.score ?? 0)) {
          seen.set(hit.id, hit)
        }
      }
    }
    return [...seen.values()]
  }

  /** 注入块规划：forced procedure → 偏好/流程 → 事件/画像，按字符预算截断。 */
  buildInjectionBlock(items: readonly StoreHit[]): InjectionBlock {
    const sorted = [...items].sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    const forced: string[] = []
    const norms: string[] = []
    const events: string[] = []
    const injectedIds: string[] = []
    let forcedCount = 0
    let normCount = 0
    let eventCount = 0
    const inject = this.config.inject

    for (const item of sorted) {
      const memoryType = item.memoryType
      const summary = item.summary.trim()
      const extra = item.extraJson
      const id = item.id
      const score = item.score ?? 0
      const typeThreshold = this.config.thresholds[memoryType as keyof typeof this.config.thresholds] ?? this.config.scoreThreshold

      if (memoryType === 'procedure' && String(extra.tool_requirement ?? '').trim()) {
        if (forcedCount >= inject.forced) continue
        forcedCount += 1
        forced.push(`- [${id}] ${summary}（必须调用工具：${String(extra.tool_requirement)}）`)
        injectedIds.push(id)
        continue
      }
      if (score < typeThreshold) continue
      if (memoryType === 'procedure' || memoryType === 'preference') {
        if (normCount >= inject.procedurePreference) continue
        normCount += 1
        const confidence = score < typeThreshold + this.config.relativeDelta ? '（有印象，不确定）' : ''
        norms.push(`- [${id}] ${summary}${confidence}`)
        injectedIds.push(id)
      } else if (memoryType === 'event' || memoryType === 'profile') {
        if (eventCount >= inject.eventProfile) continue
        eventCount += 1
        const ts = item.happenedAt ? `[${item.happenedAt}] ` : ''
        events.push(`- [${id}] ${ts}${summary}`)
        injectedIds.push(id)
      }
    }

    const parts: InjectionSection[] = []
    if (forced.length > 0) {
      parts.push({
        heading: '## 我可能记得的长期做事方式\n这些线索不能替代实时 ToolRegistry / SkillsCatalog 能力检查。',
        lines: forced,
        injectedIds: [...injectedIds],
      })
    }
    if (norms.length > 0) {
      parts.push({
        heading: '## 我可能记得的偏好与做事方式\n低置信度线索不得当作确定事实；与当前原话冲突时以当前原话为准。',
        lines: norms,
        injectedIds: [...injectedIds],
      })
    }
    if (events.length > 0) {
      parts.push({
        heading: '## 我可能记得的历史线索\n这些是检索线索，不得覆盖你当前的原话或角色设定。',
        lines: events,
        injectedIds: [...injectedIds],
      })
    }
    return this.applyCharBudget(parts)
  }

  private applyCharBudget(parts: readonly InjectionSection[]): InjectionBlock {
    const maxChars = Math.max(200, this.config.inject.maxChars)
    const finalParts: string[] = []
    const injectedIds: string[] = []
    const seenIds = new Set<string>()
    let total = 0
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!
      const body = `${part.heading}\n${part.lines.join('\n')}`
      const addLen = body.length + (finalParts.length > 0 ? 2 : 0)
      if (total + addLen > maxChars && index > 0) continue
      finalParts.push(body)
      total += addLen
      for (const itemId of part.injectedIds) {
        if (!seenIds.has(itemId)) {
          seenIds.add(itemId)
          injectedIds.push(itemId)
        }
      }
    }
    return { text: finalParts.join('\n\n'), injectedIds }
  }
}

function dedupeTexts(texts: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const text of texts) {
    const normalized = (text ?? '').trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

/** RRF 融合，镜像 Shiori `_rrf_merge`：1/(k+vec_rank) + 0.5/(k+kw_rank)。 */
export function rrfMerge(
  vectorItems: readonly StoreHit[],
  keywordItems: readonly StoreHit[],
  topN: number,
): StoreHit[] {
  const vectorRank = new Map<string, number>()
  const sortedVector = [...vectorItems].sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
  for (let index = 0; index < sortedVector.length; index += 1) {
    const id = sortedVector[index]!.id
    if (!vectorRank.has(id)) vectorRank.set(id, index + 1)
  }
  const keywordRank = new Map<string, number>()
  for (let index = 0; index < keywordItems.length; index += 1) {
    const id = keywordItems[index]!.id
    if (!keywordRank.has(id)) keywordRank.set(id, index + 1)
  }
  const byId = new Map<string, StoreHit>()
  for (const item of keywordItems) byId.set(item.id, item)
  for (const item of vectorItems) byId.set(item.id, item)

  const ids = new Set([...vectorRank.keys(), ...keywordRank.keys()])
  const scored: Array<{ id: string; rrf: number; raw: number }> = []
  for (const id of ids) {
    let rrf = 0
    const vectorPosition = vectorRank.get(id)
    if (vectorPosition !== undefined) rrf += 1 / (RRF_K + vectorPosition)
    const keywordPosition = keywordRank.get(id)
    if (keywordPosition !== undefined) rrf += KEYWORD_RRF_WEIGHT / (RRF_K + keywordPosition)
    const item = byId.get(id)
    const raw = item?.score ?? item?.keywordScore ?? 0
    scored.push({ id, rrf, raw })
  }
  scored.sort((left, right) => right.rrf - left.rrf || right.raw - left.raw)
  return scored.slice(0, topN).flatMap(entry => {
    const item = byId.get(entry.id)
    return item === undefined ? [] : [{ ...item, score: entry.rrf }]
  })
}
