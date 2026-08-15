/**
 * 轻量 DefaultMemoryEngine，镜像 Shiori `plugins/default_memory/engine/*` + `memory2/memorizer.py` 的核心：
 * query 意图分发、remember/forget、写入时语义 supersede（0.90 退休 / procedure 同工具合并）、
 * 回合后抽取（profile/preference/procedure + emotional_weight）。
 * 砍掉 HyDE / query-rewriter / sufficiency / LLM-dedup / tagger 重组件。
 */

import { createHash } from 'node:crypto'
import type {
  MemoryCapability,
  MemoryEngine,
  MemoryEngineDescriptor,
  MemoryIngestRequest,
  MemoryIngestResult,
  MemoryMutation,
  MemoryMutationResult,
  MemoryQuery,
  MemoryQueryResult,
  MemoryRecord,
  MemoryScope,
  MemoryToolProfile,
  MemoryToolSpec,
  StoreHit,
} from './contracts.ts'
import type { DefaultMemoryConfig } from './config.ts'
import { Embedder, type MemoryChatClient } from './llm.ts'
import { Retriever } from './retriever.ts'
import { ShioriMemoryStore, coerceEmotionalWeight } from './store.ts'
import type { ConsolidatedCandidate } from '../semantic-consolidation.ts'

const ENGINE_NAME = 'default'
const ENGINE_PROFILE = 'rich_memory_engine' as const
const ENGINE_CAPABILITIES: ReadonlySet<MemoryCapability> = new Set([
  'ingest.messages',
  'retrieve.semantic',
  'retrieve.context_block',
  'retrieve.structured_hits',
  'manage.history',
  'manage.update',
  'manage.delete',
  'semantics.rich_memory',
])

const SUPERSEDE_THRESHOLD = 0.9
const MERGE_THRESHOLD = 0.7
const PROFILE_HIGH_EMOTION_SUPERSEDE_THRESHOLD = 0.92
const EXTRACTION_MAX_TOKENS = 600

export interface EngineDeps {
  readonly store: ShioriMemoryStore
  readonly embedder?: Embedder
  readonly chat?: MemoryChatClient
  readonly config: DefaultMemoryConfig
}

export class DefaultMemoryEngine implements MemoryEngine {
  readonly descriptor: MemoryEngineDescriptor = {
    name: ENGINE_NAME,
    profile: ENGINE_PROFILE,
    capabilities: ENGINE_CAPABILITIES,
  }

  private readonly retriever: Retriever
  private readonly store: ShioriMemoryStore
  private embedder: Embedder | undefined
  private chat: MemoryChatClient | undefined

  constructor(deps: EngineDeps) {
    this.store = deps.store
    this.embedder = deps.embedder
    this.chat = deps.chat
    this.retriever = new Retriever(this.store, deps.embedder, deps.config.retrieval)
  }

  /** 热替换 LLM 客户端（前端保存记忆配置后调用），已挂载的 agent 立即生效。 */
  updateLlm(embedder: Embedder | undefined, chat: MemoryChatClient | undefined): void {
    this.embedder = embedder
    this.chat = chat
    this.retriever.setEmbedder(embedder)
  }

  /** Persist Shiori consolidation events with source-ref idempotency. */
  async ingestConsolidationEvents(
    roleId: string,
    sourceRef: string,
    events: readonly ConsolidationMemoryEvent[],
  ): Promise<void> {
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!
      const entrySourceRef = `${sourceRef}#event:${index}`
      if (this.store.hasConsolidationSourceRef(entrySourceRef)) continue
      let embedding: number[] | undefined
      if (this.embedder !== undefined) {
        try {
          embedding = await this.embedder.embed(event.summary)
        } catch {
          embedding = undefined
        }
      }
      this.store.upsertConsolidationEvent({
        sourceRef: entrySourceRef,
        summary: event.summary,
        ...(embedding === undefined ? {} : { embedding }),
        emotionalWeight: event.emotionalWeight ?? 0,
        extra: { role_id: roleId, memory_domain: 'shared' },
      })
    }
  }

  /** Persist compaction long-term candidates under stable per-entry source refs. */
  async ingestConsolidationCandidates(
    roleId: string,
    sourceRef: string,
    candidates: readonly ConsolidatedCandidate[],
  ): Promise<void> {
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!
      const entrySourceRef = `${sourceRef}#long-term:${index}`
      if (this.store.hasConsolidationLongTermRef(entrySourceRef)) continue
      const profile = candidateProfile(candidate.tag)
      const result = await this.mutate({
        kind: 'remember',
        scope: { roleId },
        summary: candidate.content,
        memoryKind: profile.memoryKind,
        sourceRef: entrySourceRef,
        metadata: { category: profile.category, consolidation_tag: candidate.tag },
      })
      this.store.markConsolidationLongTermRef(entrySourceRef, result.itemId)
    }
  }

  isCompactionComplete(sourceRef: string): boolean {
    return this.store.hasCompletedCompaction(sourceRef)
  }

  markCompactionCompleted(sourceRef: string): void {
    this.store.markCompactionCompleted(sourceRef)
  }

  /** Build Shiori's bounded deduplication block from durable long-term items. */
  longTermContext(roleId: string): string {
    const { items } = this.store.listItemsForAdmin({
      roleId,
      status: 'active',
      pageSize: 100,
      sortBy: 'updated_at',
      sortOrder: 'desc',
    })
    return items
      .filter(item => ['profile', 'preference', 'procedure'].includes(String(item.memory_type)))
      .map(item => `- [${String(item.memory_type)}] ${String(item.summary)}`)
      .join('\n')
      .slice(0, 6000)
  }

  // -------------------------------------------------------------------------
  // 查询（plugins/default_memory/engine/query.py 简化）
  // -------------------------------------------------------------------------

  async query(request: MemoryQuery): Promise<MemoryQueryResult> {
    const scope = normalizeScope(request.scope)
    const intent = request.intent ?? 'answer'
    if (intent === 'timeline') return this.queryTimeline(request, scope)
    if (intent === 'interest') return this.queryInterest(request, scope)

    // 空查询：返回该角色最近的 active 记忆（context 注入与空 recall 使用）
    if (!request.text?.trim()) {
      const { items } = this.store.listItemsForAdmin({
        roleId: scope.roleId,
        status: 'active',
        pageSize: request.limit ?? 8,
        sortBy: 'updated_at',
        sortOrder: 'desc',
      })
      const records = items.map(item => {
        const domain = String(item.memory_domain ?? '')
        const sourceRef = item.source_ref === undefined || item.source_ref === null ? undefined : String(item.source_ref)
        return {
          id: String(item.id),
          kind: String(item.memory_type),
          ...(domain ? { domain } : {}),
          summary: String(item.summary),
          score: 1,
          engineKind: ENGINE_NAME,
          signals: (item.extra_json ?? {}) as Readonly<Record<string, unknown>>,
          ...(sourceRef === undefined ? {} : { evidence: [{ kind: 'turn' as const, refs: [] as const, sourceRef }] }),
        }
      })
      const textBlock = records.length === 0
        ? ''
        : ['Role memory relevant to this agent:', ...records.map(record => `- [${record.id}] (${record.kind}/${record.domain ?? 'role_self'}) ${record.summary}`)].join('\n')
      return {
        textBlock,
        records,
        trace: { engine: ENGINE_NAME, profile: ENGINE_PROFILE, intent: 'context', effect: request.effect ?? 'stateful', hit_count: records.length },
      }
    }

    const memoryTypes = resolveMemoryTypes(request)
    const domains = request.filters?.domains
    const auxQueries = request.filters?.hints?.queries as readonly string[] | undefined
    const requireScopeMatch = Boolean(request.filters?.hints?.require_scope_match)
    const items = await this.retriever.retrieve({
      query: request.text,
      ...(auxQueries === undefined ? {} : { auxQueries }),
      ...(memoryTypes === undefined ? {} : { memoryTypes }),
      ...(domains === undefined ? {} : { memoryDomains: domains }),
      topK: Math.max(request.limit ?? 8, 15),
      ...(intent === 'answer' ? { scoreThreshold: 0.35 } : {}),
      ...(scope.roleId === undefined ? {} : { roleId: scope.roleId }),
      ...(scope.channel === undefined ? {} : { scopeChannel: scope.channel }),
      ...(scope.chatId === undefined ? {} : { scopeChatId: scope.chatId }),
      ...(requireScopeMatch ? { requireScopeMatch: true } : {}),
      ...(request.filters?.timeStart === undefined ? {} : { timeStart: request.filters.timeStart }),
      ...(request.filters?.timeEnd === undefined ? {} : { timeEnd: request.filters.timeEnd }),
      hotnessAlpha: 0.2,
    })
    const sliced = items.slice(0, request.limit ?? 8)
    const injection = this.retriever.buildInjectionBlock(sliced)
    const injectedIds = new Set(injection.injectedIds)
    return {
      textBlock: injection.text,
      records: sliced.map(item => this.buildRecord(item, injectedIds)),
      trace: {
        engine: ENGINE_NAME,
        profile: ENGINE_PROFILE,
        intent,
        effect: request.effect ?? 'stateful',
        hit_count: sliced.length,
      },
      raw: { items: sliced },
    }
  }

  private queryTimeline(request: MemoryQuery, scope: MemoryScope): MemoryQueryResult {
    const timeStart = request.filters?.timeStart
    const timeEnd = request.filters?.timeEnd
    if (timeStart === undefined || timeEnd === undefined) {
      return { records: [], trace: { engine: ENGINE_NAME, intent: 'timeline', effect: request.effect } }
    }
    const hits = this.store.listEventsByTimeRange(timeStart, timeEnd, {
      limit: request.limit ?? 200,
      ...(request.filters?.domains === undefined ? {} : { memoryDomains: request.filters.domains }),
      ...(scope.roleId === undefined ? {} : { roleId: scope.roleId }),
      ...(scope.channel === undefined ? {} : { scopeChannel: scope.channel }),
      ...(scope.chatId === undefined ? {} : { scopeChatId: scope.chatId }),
      requireScopeMatch: Boolean(scope.channel && scope.chatId),
    })
    return {
      records: hits.map(item => this.buildRecord(item as unknown as StoreHit)),
      trace: { engine: ENGINE_NAME, intent: 'timeline', effect: request.effect, hit_count: hits.length },
    }
  }

  private async queryInterest(request: MemoryQuery, scope: MemoryScope): Promise<MemoryQueryResult> {
    const items = await this.retriever.retrieve({
      query: request.text,
      memoryTypes: ['preference', 'profile'],
      ...(request.filters?.domains === undefined ? {} : { memoryDomains: request.filters.domains }),
      topK: request.limit ?? 8,
      ...(scope.roleId === undefined ? {} : { roleId: scope.roleId }),
      ...(scope.channel === undefined ? {} : { scopeChannel: scope.channel }),
      ...(scope.chatId === undefined ? {} : { scopeChatId: scope.chatId }),
      ...(Boolean(request.filters?.hints?.require_scope_match) ? { requireScopeMatch: true } : {}),
    })
    const records = items.map(item => this.buildRecord(item))
    return {
      textBlock: records.map(record => record.summary).join('\n---\n'),
      records,
      trace: { engine: ENGINE_NAME, intent: 'interest', effect: request.effect, hit_count: records.length },
    }
  }

  private buildRecord(item: StoreHit, injectedIds?: ReadonlySet<string>): MemoryRecord {
    const extra = item.extraJson
    return {
      id: item.id,
      kind: item.memoryType,
      domain: item.memoryDomain ?? '',
      summary: item.summary,
      score: item.score ?? item.keywordScore ?? 0,
      engineKind: ENGINE_NAME,
      evidence: item.sourceRef ? [{ kind: 'turn', refs: [], sourceRef: item.sourceRef }] : [],
      signals: extra,
      injected: injectedIds?.has(item.id) ?? false,
    }
  }

  // -------------------------------------------------------------------------
  // 写入（engine/mutation.py + memorizer.py 简化）
  // -------------------------------------------------------------------------

  async mutate(request: MemoryMutation): Promise<MemoryMutationResult> {
    if (request.kind === 'forget') return this.forget(request)
    return this.remember(request)
  }

  private async remember(request: MemoryMutation): Promise<MemoryMutationResult> {
    const scope = normalizeScope(request.scope)
    const summary = (request.summary ?? '').trim()
    if (!summary) throw new Error('shiori-role: memory summary must not be empty')
    const steps = Array.isArray(request.metadata?.steps)
      ? request.metadata.steps.map(step => String(step)).filter(Boolean)
      : undefined
    const toolRequirement = request.metadata?.tool_requirement === undefined
      ? undefined
      : String(request.metadata.tool_requirement)
    const category = request.metadata?.category === undefined ? undefined : String(request.metadata.category)
    const memoryType = coerceMemoryType(request.memoryKind, toolRequirement, steps)
    const extra: Record<string, unknown> = {
      ...(toolRequirement === undefined ? {} : { tool_requirement: toolRequirement }),
      steps: steps ?? [],
      role_id: scope.roleId ?? '',
    }
    const memoryDomain = resolveDomainForWrite(request.memoryDomain, memoryType)
    if (memoryDomain) extra.memory_domain = memoryDomain

    const happenedAt = request.happenedAt?.trim() || undefined
    const emotionalWeight = coerceEmotionalWeight(request.metadata?.emotional_weight)
    // 字段同步进 extra（signals 可见），列同步存（hotness 使用）
    if (category !== undefined && category !== '') extra.category = category
    if (emotionalWeight > 0) extra.emotional_weight = emotionalWeight

    // embedding + 语义 supersede（无 embedder 时跳过，仅 content-hash 去重）
    let embedding: number[] | undefined
    if (this.embedder !== undefined) {
      try {
        embedding = await this.embedder.embed(summary)
        const mergedId = this.supersedeRelated(memoryType, embedding, extra, emotionalWeight, scope.roleId, summary)
        if (mergedId !== undefined) {
          // 已合并进既有条目，不再新建
          return { accepted: true, itemId: mergedId, actualKind: memoryType, status: 'merged' }
        }
      } catch {
        embedding = undefined
      }
    }

    const result = this.store.upsertItem(memoryType, summary, embedding, {
      sourceRef: (request.sourceRef ?? '').trim() || 'memorize_tool',
      extra,
      ...(happenedAt === undefined ? {} : { happenedAt }),
      emotionalWeight,
    })
    const separator = result.indexOf(':')
    const status = separator === -1 ? 'new' : result.slice(0, separator)
    const itemId = separator === -1 ? result : result.slice(separator + 1)
    return { accepted: Boolean(itemId), itemId, actualKind: memoryType, status }
  }

  /** 语义 supersede：procedure/preference 高相似退休；procedure 同工具合并。返回 merge 目标 id（若有）。 */
  private supersedeRelated(
    memoryType: string,
    embedding: readonly number[],
    extra: Record<string, unknown>,
    emotionalWeight: number,
    roleId: string | undefined,
    newSummary: string,
  ): string | undefined {
    if (this.embedder === undefined) return undefined
    const toolRequirement = String(extra.tool_requirement ?? '') || undefined

    if (memoryType === 'procedure' || memoryType === 'preference') {
      const similar = this.store.vectorSearch(embedding, {
        topK: 5,
        memoryTypes: [memoryType],
        scoreThreshold: Math.min(MERGE_THRESHOLD, SUPERSEDE_THRESHOLD),
        ...(roleId === undefined ? {} : { roleId }),
      })
      if (memoryType === 'procedure' && toolRequirement) {
        const target = similar.find(item =>
          (item.score ?? 0) >= MERGE_THRESHOLD
          && String(item.extraJson.tool_requirement ?? '') === toolRequirement,
        )
        if (target) {
          const mergedSummary = mergeSummaryText(target.summary, newSummary)
          this.store.mergeItemRaw({
            itemId: target.id,
            newSummary: mergedSummary,
            newHash: contentHashForStore(mergedSummary, 'procedure'),
            newEmbedding: embedding,
            newExtra: { ...target.extraJson, ...extra },
          })
          this.store.recordReplacements({
            oldItems: [{ id: target.id, memory_type: target.memoryType, summary: target.summary, extra_json: target.extraJson }],
            newItem: { id: target.id, memory_type: memoryType, summary: mergedSummary, extra_json: extra },
            sourceRef: 'procedure-merge',
            relationType: 'merge',
          })
          return target.id
        }
      }
      const supersedeIds = similar.filter(item => (item.score ?? 0) >= SUPERSEDE_THRESHOLD).map(item => item.id)
      if (supersedeIds.length > 0) this.store.markSupersededBatch(supersedeIds)
      return undefined
    }

    if (memoryType === 'profile') {
      const category = String(extra.category ?? '')
      if (category === 'status' || category === 'purchase') {
        const similar = this.store.vectorSearch(embedding, {
          topK: 5,
          memoryTypes: ['profile'],
          scoreThreshold: SUPERSEDE_THRESHOLD,
          ...(roleId === undefined ? {} : { roleId }),
        })
        const threshold = emotionalWeight >= 7 ? PROFILE_HIGH_EMOTION_SUPERSEDE_THRESHOLD : SUPERSEDE_THRESHOLD
        const supersedeIds = similar
          .filter(item => (item.score ?? 0) >= threshold && String(item.extraJson.category ?? '') === category)
          .map(item => item.id)
        if (supersedeIds.length > 0) this.store.markSupersededBatch(supersedeIds)
      }
    }
  }

  private forget(request: MemoryMutation): MemoryMutationResult {
    const scope = normalizeScope(request.scope)
    const cleanIds = [...new Set((request.ids ?? []).map(id => String(id).trim()).filter(Boolean))]
    const items = this.store.getItemsByIds(cleanIds)
      .filter(item => itemMatchesForgetScope(item, scope))
    const foundIds = items.flatMap(item => (item.id ? [String(item.id)] : []))
    if (foundIds.length > 0) this.store.markSupersededBatch(foundIds)
    return {
      accepted: foundIds.length > 0,
      status: 'superseded',
      affectedIds: foundIds,
      missingIds: cleanIds.filter(id => !foundIds.includes(id)),
      items: items.map(item => ({ id: item.id, memory_type: item.memory_type, summary: item.summary })),
    }
  }

  reinforceItemsBatch(ids: readonly string[]): void {
    this.store.reinforceItemsBatch(ids)
  }

  /** 兼容便捷方法：返回角色最近的记忆记录。 */
  async recall(roleId: string, text?: string, limit = 10): Promise<MemoryRecord[]> {
    const result = await this.query({
      text: text ?? '',
      intent: 'context',
      scope: { roleId },
      limit,
      effect: 'read_only',
    })
    return [...result.records]
  }

  /** 同步上下文文本（prompt 注入用，避免异步组装）。 */
  contextText(scope: MemoryScope, limit = 8): string {
    const normalized = normalizeScope(scope)
    const { items } = this.store.listItemsForAdmin({
      roleId: normalized.roleId,
      status: 'active',
      pageSize: limit,
      sortBy: 'updated_at',
      sortOrder: 'desc',
    })
    if (items.length === 0) return ''
    const lines = items.map(item =>
      `- [${String(item.id)}] (${String(item.memory_type)}/${String(item.memory_domain ?? 'role_self')}) ${String(item.summary)}`,
    )
    return ['Role memory relevant to this agent:', ...lines].join('\n')
  }

  // -------------------------------------------------------------------------
  // 回合后抽取（post_response_worker 的隐式抽取部分，砍掉 invalidation）
  // -------------------------------------------------------------------------

  async ingest(request: MemoryIngestRequest, chat: MemoryChatClient | undefined = this.chat): Promise<MemoryIngestResult> {
    if (chat === undefined) {
      return { accepted: false, summary: 'chat client unavailable', raw: { reason: 'chat_unavailable' } }
    }
    if (request.sourceKind !== 'conversation_turn' && request.sourceKind !== 'conversation_batch') {
      return { accepted: false, summary: 'unsupported source_kind', raw: { reason: 'unsupported_source_kind' } }
    }
    const normalized = normalizeIngestContent(request.content)
    if (normalized === undefined) {
      return { accepted: false, summary: 'unsupported content', raw: { reason: 'invalid_content' } }
    }
    const scope = normalizeScope(request.scope)
    const sourceRef = String(request.metadata?.source_ref ?? normalized.sourceRef ?? `${scope.sessionKey ?? 'session'}@post_response`)
    const conversation = normalized.conversation
      || (normalized.userMessage || normalized.assistantResponse
        ? `USER: ${normalized.userMessage}\nASSISTANT: ${normalized.assistantResponse}`.trim()
        : '')
    if (!conversation) return { accepted: true, summary: 'empty conversation', raw: { engine: ENGINE_NAME } }

    const existingProfile = this.existingLongTermMemory(scope.roleId)
    try {
      const content = await chat.chat(
        [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: extractionPrompt(conversation.slice(0, 12_000), existingProfile) },
        ],
        { maxTokens: EXTRACTION_MAX_TOKENS, temperature: 0, disableThinking: true },
      )
      const items = parseExtractionPayload(content)
      for (const item of items) {
        await this.mutate({
          kind: 'remember',
          scope: { roleId: scope.roleId, ...(scope.sessionKey === undefined ? {} : { sessionKey: scope.sessionKey }) },
          summary: item.summary,
          ...(item.kind === undefined ? {} : { memoryKind: item.kind }),
          ...(item.happenedAt === undefined ? {} : { happenedAt: item.happenedAt }),
          sourceRef: `${sourceRef}${item.kind === 'profile' ? '#profile' : '#implicit'}`,
          metadata: {
            ...(item.category === undefined ? {} : { category: item.category }),
            ...(item.emotionalWeight === undefined ? {} : { emotional_weight: item.emotionalWeight }),
            ...(item.toolRequirement === undefined ? {} : { tool_requirement: item.toolRequirement }),
            ...(item.steps === undefined || item.steps.length === 0 ? {} : { steps: item.steps }),
          },
        })
      }
      return { accepted: true, summary: `extracted ${items.length} memories`, raw: { engine: ENGINE_NAME } }
    } catch (error) {
      return { accepted: false, summary: 'extraction failed', raw: { engine: ENGINE_NAME, error: String(error) } }
    }
  }

  private existingLongTermMemory(roleId: string | undefined): string {
    const items = this.store.listItemsForAdmin({
      ...(roleId === undefined ? {} : { roleId }),
      status: 'active',
      pageSize: 100,
      sortBy: 'updated_at',
      sortOrder: 'desc',
    }).items
    return items
      .filter(item => ['profile', 'preference', 'procedure'].includes(String(item.memory_type)))
      .map(item => `- [${String(item.memory_type)}] ${String(item.summary)}`)
      .join('\n')
      .slice(0, 6000)
  }

  // -------------------------------------------------------------------------
  // 工具契约与 admin
  // -------------------------------------------------------------------------

  toolProfile(): MemoryToolProfile {
    return {
      recall: recallSpec(),
      memorize: memorizeSpec(),
      forget: forgetSpec(),
    }
  }

  listItemsForAdmin(options: Parameters<MemoryEngine['listItemsForAdmin']>[0] = {}): ReturnType<MemoryEngine['listItemsForAdmin']> {
    const { items, total } = this.store.listItemsForAdmin(options)
    return { items, total }
  }

  getItemForAdmin(itemId: string, includeEmbedding = false): ReturnType<MemoryEngine['getItemForAdmin']> {
    return this.store.getItemForAdmin(itemId, includeEmbedding)
  }

  updateItemForAdmin(itemId: string, patch: Parameters<MemoryEngine['updateItemForAdmin']>[1]): ReturnType<MemoryEngine['updateItemForAdmin']> {
    return this.store.updateItemForAdmin(itemId, patch)
  }

  deleteItem(itemId: string): boolean {
    return this.store.deleteItem(itemId)
  }

  deleteItemsBatch(ids: readonly string[]): number {
    return this.store.deleteItemsBatch(ids)
  }

  invalidateRoleMemories(roleId: string): number {
    return this.store.invalidateRoleMemories(roleId)
  }

  findSimilarItemsForAdmin(itemId: string, options: Parameters<MemoryEngine['findSimilarItemsForAdmin']>[1] = {}): ReturnType<MemoryEngine['findSimilarItemsForAdmin']> {
    return this.store.findSimilarItemsForAdmin(itemId, options)
  }

  keywordMatchProcedures(actionTokens: readonly string[]): ReturnType<MemoryEngine['keywordMatchProcedures']> {
    return this.store.keywordMatchProcedures(actionTokens)
  }

  listEventsByTimeRange(timeStart: string, timeEnd: string, options: Parameters<MemoryEngine['listEventsByTimeRange']>[2] = {}): ReturnType<MemoryEngine['listEventsByTimeRange']> {
    return this.store.listEventsByTimeRange(timeStart, timeEnd, options)
  }
}

function candidateProfile(tag: ConsolidatedCandidate['tag']): { memoryKind: 'profile' | 'preference'; category: string } {
  switch (tag) {
    case 'preference': return { memoryKind: 'preference', category: 'preference' }
    case 'correction': return { memoryKind: 'profile', category: 'status' }
    case 'requested_memory': return { memoryKind: 'profile', category: 'decision' }
    case 'identity':
    case 'key_info':
    case 'health_long_term': return { memoryKind: 'profile', category: 'personal_fact' }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function normalizeScope(scope?: MemoryScope): Required<Pick<MemoryScope, 'roleId'>> & MemoryScope {
  const roleId = (scope?.roleId ?? '').trim()
  if (!roleId) throw new Error('shiori-role: memory scope requires a role id')
  return {
    roleId,
    ...(scope?.sessionKey?.trim() ? { sessionKey: scope.sessionKey.trim() } : {}),
    ...(scope?.channel?.trim() ? { channel: scope.channel.trim() } : {}),
    ...(scope?.chatId?.trim() ? { chatId: scope.chatId.trim() } : {}),
  }
}

function resolveMemoryTypes(request: MemoryQuery): readonly string[] | undefined {
  const kinds = request.filters?.kinds
  if (kinds !== undefined && kinds.length > 0) return kinds.map(kind => String(kind)).filter(Boolean)
  if (request.intent === 'procedure') return ['procedure', 'preference']
  return undefined
}

/** procedure 必须有执行条件，否则降级 preference（镜像 `_coerce_memory_type`）。 */
function coerceMemoryType(memoryKind: string | undefined, toolRequirement: string | undefined, steps: readonly string[] | undefined): string {
  const memoryType = memoryKind?.trim() || 'fact'
  if (memoryType !== 'procedure') return memoryType
  if (toolRequirement && toolRequirement.trim()) return memoryType
  if (steps && steps.some(step => step.trim())) return memoryType
  return 'preference'
}

/** 默认记忆域：profile/preference/procedure/event → relationship（镜像 `_resolve_memory_domain_for_write`）。 */
function resolveDomainForWrite(explicit: string | undefined, memoryType: string): string | undefined {
  const value = explicit?.trim()
  if (value) return value
  if (memoryType === 'identity' || memoryType === 'background' || memoryType === 'principle') return 'role_self'
  if (memoryType === 'profile' || memoryType === 'preference' || memoryType === 'procedure' || memoryType === 'event') return 'relationship'
  return undefined
}

function itemMatchesForgetScope(item: Readonly<Record<string, unknown>>, scope: MemoryScope): boolean {
  const extra = item.extra_json
  const extraJson = typeof extra === 'object' && extra !== null ? extra as Record<string, unknown> : {}
  if (String(extraJson.role_id ?? '').trim() !== String(scope.roleId ?? '').trim()) return false
  const scopeChannel = (scope.channel ?? '').trim()
  const scopeChatId = (scope.chatId ?? '').trim()
  const itemChannel = String(extraJson.scope_channel ?? '').trim()
  const itemChatId = String(extraJson.scope_chat_id ?? '').trim()
  if (!scopeChannel || !scopeChatId) return true
  if (!itemChannel && !itemChatId) return true
  return itemChannel === scopeChannel && itemChatId === scopeChatId
}

function mergeSummaryText(oldSummary: string, newSummary: string): string {
  const oldText = (oldSummary ?? '').trim()
  const newText = (newSummary ?? '').trim()
  if (!oldText) return newText
  if (!newText) return oldText
  // 镜像 Shiori `_merge_summary_text`：谁包含谁就保留更完整的版本
  if (oldText.includes(newText)) return oldText
  if (newText.includes(oldText)) return newText
  return `${oldText.replace(/[。；;，, ]+$/, '')}；${newText}`
}

function contentHashForStore(summary: string, memoryType: string): string {
  // 与 store.contentHash 保持一致（sha256[:16]）
  const text = summary.toLowerCase().replace(/\s+/g, ' ').trim() + memoryType
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function normalizeIngestContent(content: unknown): { userMessage: string; assistantResponse: string; sourceRef: string; conversation?: string } | undefined {
  if (typeof content === 'string') {
    const text = content.trim()
    return text ? { userMessage: '', assistantResponse: '', sourceRef: '', conversation: text } : undefined
  }
  if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
    const record = content as Record<string, unknown>
    return {
      userMessage: String(record.user_message ?? ''),
      assistantResponse: String(record.assistant_response ?? ''),
      sourceRef: String(record.source_ref ?? ''),
    }
  }
  if (Array.isArray(content)) {
    let userMessage = ''
    let assistantResponse = ''
    for (const message of content) {
      if (typeof message !== 'object' || message === null) continue
      const record = message as Record<string, unknown>
      const role = String(record.role ?? '')
      const body = String(record.content ?? '')
      if (role === 'user' && body) userMessage = body
      else if (role === 'assistant' && body) assistantResponse = body
    }
    if (!userMessage && !assistantResponse) return undefined
    return { userMessage, assistantResponse, sourceRef: '' }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 抽取 prompt（镜像 Shiori `_build_long_term_prompt` 精简版）
// ---------------------------------------------------------------------------

export interface ExtractedMemory {
  readonly summary: string
  readonly kind?: string
  readonly happenedAt?: string
  readonly emotionalWeight?: number
  readonly category?: string
  readonly toolRequirement?: string
  readonly steps?: readonly string[]
}

export interface ConsolidationMemoryEvent {
  readonly summary: string
  readonly emotionalWeight?: number
}

const EXTRACTION_SYSTEM_PROMPT = '你是中性的长期记忆提取器，不扮演角色，也不生成用户可见回复。'

function extractionPrompt(conversation: string, existingProfile: string): string {
  return `你是中性的长期记忆提取器，不扮演角色，也不生成用户可见回复。从对话窗口中一次性提取长期记忆，返回 JSON。

视角契约：USER 是当前角色交流对象"你"，ASSISTANT 是当前角色"我"。只有 USER 的直接陈述或明确确认可以成为关于"你"的证据；ASSISTANT、工具结果和未确认转贴材料都不能成为事实。

默认答案是所有数组为空。提取门槛要高，宁可不提取，也不要把临时信息写进长期记忆。

【核心判断标准】
把这条信息放进 6 个月后的一次全新对话，它还有用吗？
→ 是 → 可能是长期记忆，继续检查
→ 否 → 不是长期记忆，留空

【三类记忆的语义】
profile — 关于"你"本人或客观处境的事实（身份背景、持有物、爱好、健康事实、长期状态、重要决定）
  允许 category：personal_fact / purchase / decision / status
  要求：只有 USER 在对话中直接陈述自身的事实，才允许提取
  禁止：用户提问、追问、反问、记忆测试句一律不算事实披露，绝对禁止反推
preference — "你"明确表达的长期偏好（跨 session 稳定成立的偏好/厌恶/倾向，而非硬约束）
procedure — "你"明确教给"我"的长期做事方式（跨任务可复用的明确规则）
绝对不输出：event（有时间性的具体事件）

每条记忆都必须额外输出 emotional_weight（0-10）：
- 纯技术讨论、普通事实陈述、工具步骤、没有明显情绪色彩 → 0
- 有明确喜欢/厌恶、明显情绪波动、关系张力、受挫或强烈在意 → 3-9
- 不确定时保守输出 0

【preference / procedure 提取前检查，任一不通过即不提取】
▸ 检查 A — USER 原话锚点：在 USER 消息里找到支撑这条记忆的直接原句（逐字存在，不是推断）
▸ 检查 B — 时效性：只有明确跨 session 稳定成立才继续；涉及当前任务/本次/今天/这个项目 → 不提取
▸ 检查 C — 来源方向：核心内容来自 ASSISTANT（解释/建议/工具结果）→ 不提取；USER 没有反驳 ≠ 认同

【summary 写法约束】
- 只包含 USER 原话中直接出现的内容，不能加推断或延伸
- summary 语气不得强于 USER 原话
- summary 脱离对话也能独立成立，不含"这次""今天""当前"等时间锚
- 不能只是原话碎片，必须是完整句

【当前已有记忆（用于查重）】
${existingProfile || '（空）'}

【待处理对话】
${conversation}

只返回合法 JSON，不要 markdown 代码块：
{
  "profile": [{"summary": "...", "category": "personal_fact|purchase|decision|status", "happened_at": null, "emotional_weight": 0}],
  "preference": [{"summary": "...", "emotional_weight": 0}],
  "procedure": [{"summary": "...", "emotional_weight": 0}]
}`
}

function parseExtractionPayload(content: string): ExtractedMemory[] {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(content.slice(start, end + 1))
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const record = parsed as Record<string, unknown>
  const items: ExtractedMemory[] = []
  const collect = (key: 'profile' | 'preference' | 'procedure') => {
    const list = record[key]
    if (!Array.isArray(list)) return
    for (const candidate of list) {
      if (typeof candidate !== 'object' || candidate === null) continue
      const item = candidate as Record<string, unknown>
      const summary = typeof item.summary === 'string' ? item.summary.trim() : ''
      if (!summary) continue
      const happenedAt = typeof item.happened_at === 'string' ? item.happened_at.trim() : undefined
      const emotionalWeight = typeof item.emotional_weight === 'number' ? item.emotional_weight : undefined
      const category = typeof item.category === 'string' ? item.category.trim() : undefined
      const toolRequirement = typeof item.tool_requirement === 'string' ? item.tool_requirement.trim() : undefined
      const steps = Array.isArray(item.steps)
        ? item.steps.filter((step): step is string => typeof step === 'string').map(step => step.trim()).filter(Boolean)
        : undefined
      items.push({
        summary,
        kind: key,
        ...(happenedAt === undefined || happenedAt === '' ? {} : { happenedAt }),
        ...(emotionalWeight === undefined ? {} : { emotionalWeight }),
        ...(category === undefined || category === '' ? {} : { category }),
        ...(toolRequirement === undefined || toolRequirement === '' ? {} : { toolRequirement }),
        ...(steps === undefined || steps.length === 0 ? {} : { steps }),
      })
    }
  }
  collect('profile')
  collect('preference')
  collect('procedure')
  return items
}

// ---------------------------------------------------------------------------
// 工具契约（对齐现有 recall_memory / memorize / forget_memory 工具）
// ---------------------------------------------------------------------------

function recallSpec(): MemoryToolSpec {
  return {
    description: '检索长期记忆中的事实、偏好、流程与历史事件线索。query 写成陈述句；intent=answer 做主题检索，intent=timeline 做时间线回顾。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查找的记忆主题，推荐写成陈述句' },
        intent: { type: 'string', enum: ['answer', 'timeline'], description: 'answer=主题检索；timeline=按时间范围列出历史事件', default: 'answer' },
        memory_kind: { type: 'string', enum: ['event', 'profile', 'preference', 'procedure', ''], description: '限定记忆类型，留空表示不限', default: '' },
        limit: { type: 'integer', description: '最多返回条数', minimum: 1, maximum: 200, default: 8 },
      },
      required: ['query'],
    },
    risk: 'read-only',
    searchHint: '记得 以前 历史 做过什么 有没有 重构 记忆查询',
  }
}

function memorizeSpec(): MemoryToolSpec {
  return {
    description: '把你明确要求当前角色长期记住的信息写入当前角色的记忆。memory_kind 可选 event/profile/preference/procedure；procedure 表示你明确教给我的长期做事方式。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '一句话描述要记住的内容' },
        memory_kind: { type: 'string', enum: ['procedure', 'preference', 'event', 'profile', ''], description: '记忆类型，留空由 engine 决定', default: '' },
        tool_requirement: { type: 'string', description: '该规则要求必须调用的工具名（可选）' },
        steps: { type: 'array', items: { type: 'string' }, description: '执行步骤（可选）' },
      },
      required: ['summary'],
    },
    risk: 'write',
  }
}

function forgetSpec(): MemoryToolSpec {
  return {
    description: '在当前角色作用域内，将已召回的、确认错误的记忆标记为失效。',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '要失效的 memory item id 列表' },
      },
      required: ['ids'],
    },
    risk: 'write',
    searchHint: '记错了 删除记忆 撤销错误记忆 失效记忆',
  }
}
