import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  RoleMemory,
  RoleMemoryDomain,
  RoleMemoryEvidence,
  RoleMemoryMutation,
  RoleMemoryMutationResult,
  RoleMemoryQuery,
  RoleMemoryQueryIntent,
  RoleMemoryQueryResult,
  RoleMemoryScope,
} from './memory-contract.ts'
import type { StoredRoleMemoryRecord } from './spec.ts'

interface MarkdownMemoryTable {
  readMarkdown(roleId: string): string
}

/** OpenAI-compatible embedding endpoint used by the semantic layer. */
export interface MemoryEmbeddingConfig {
  readonly endpoint: string
  readonly apiKey?: string | undefined
  readonly model: string
}

/** OpenAI-compatible chat endpoint used for post-turn extraction. */
export interface MemoryExtractionConfig {
  readonly endpoint: string
  readonly apiKey?: string | undefined
  readonly model: string
}

/** One structured memory candidate produced by post-turn extraction. */
export interface ExtractedMemory {
  readonly summary: string
  /** Shiori memory_type vocabulary: profile | preference | procedure. */
  readonly kind?: string
  readonly domain?: RoleMemoryDomain
  readonly happenedAt?: string
  readonly emotionalWeight?: number
  /** profile category: personal_fact | purchase | decision | status. */
  readonly category?: string
  readonly toolRequirement?: string
  readonly steps?: readonly string[]
}

interface MemoryServiceOptions {
  readonly embedding?: MemoryEmbeddingConfig
}

const MEMORY_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: JSON.stringify(value),
  }],
}

const MEMORY_CONTEXT_ORDER = 100
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
/** Reciprocal Rank Fusion constant, mirrored from Shiori's memory2 retriever. */
const RRF_K = 60
/** Keyword lane rank weight in the fusion, mirrored from Shiori. */
const KEYWORD_RRF_WEIGHT = 0.5
/** Cosine threshold for the vector lane, mirrored from Shiori's answer intent. */
const VECTOR_SCORE_THRESHOLD = 0.35
/** Upper bound of vector-lane candidates per query. */
const VECTOR_LANE_LIMIT = 30

function normalizedScope(scope: RoleMemoryScope): RoleMemoryScope {
  const roleId = scope.roleId.trim()
  if (!roleId) throw new Error('shiori-role: memory scope requires a role id')
  return {
    roleId,
    ...(scope.sessionKey?.trim() ? { sessionKey: scope.sessionKey.trim() } : {}),
    ...(scope.channel?.trim() ? { channel: scope.channel.trim() } : {}),
    ...(scope.chatId?.trim() ? { chatId: scope.chatId.trim() } : {}),
  }
}

function normalizedDomain(value?: string): RoleMemoryDomain {
  if (value === undefined || value === '') return 'role_self'
  if (value === 'role_self' || value === 'relationship' || value === 'shared') return value
  throw new Error(`shiori-role: unknown memory domain '${value}'`)
}

function limited(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)))
}

function contentHash(value: string): string {
  let hash = 2166136261
  for (const character of value.normalize('NFKC').trim().toLocaleLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function scopeMatches(record: RoleMemory, scope: RoleMemoryScope): boolean {
  if (record.scope.roleId !== scope.roleId) return false
  if (scope.sessionKey !== undefined && record.scope.sessionKey !== scope.sessionKey) return false
  if (scope.channel !== undefined && record.scope.channel !== scope.channel) return false
  if (scope.chatId !== undefined && record.scope.chatId !== scope.chatId) return false
  return true
}

/** Role-scoped durable memory service with Shiori-shaped query and mutation contracts. */
export class ShioriMemoryService {
  private idSequence = 0

  constructor(
    private readonly table: KvTable<string, StoredRoleMemoryRecord>,
    private readonly options: MemoryServiceOptions = {},
  ) {}

  /** Execute a deterministic structured query within one role boundary. */
  query(request: RoleMemoryQuery): RoleMemoryQueryResult {
    const scope = normalizedScope(request.scope)
    const needle = request.text?.trim().toLocaleLowerCase()
    const kinds = request.kinds === undefined ? undefined : new Set(request.kinds.map(kind => kind.trim()).filter(Boolean))
    const domains = request.domains === undefined ? undefined : new Set(request.domains)
    const records = [...this.table.entries()]
      .map(([id, record]) => this.toMemory(id, record))
      .filter(record => record.status === 'active')
      .filter(record => record.scope.roleId === scope.roleId)
      .filter(record => request.requireScopeMatch !== true || scopeMatches(record, scope))
      .filter(record => kinds === undefined || kinds.has(record.kind))
      .filter(record => domains === undefined || domains.has(record.domain))
      .filter(record => needle === undefined || needle === '' || record.summary.toLocaleLowerCase().includes(needle))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limited(request.limit))
    const intent: RoleMemoryQueryIntent = request.intent ?? 'answer'
    const effect = request.effect ?? 'read_only'
    return {
      textBlock: this.renderContextBlock(records),
      records,
      trace: { engine: 'shiori-role', intent, effect, retrieval: 'deterministic-text' },
    }
  }

  /**
   * Query with Shiori-style hybrid retrieval: the keyword lane keeps literal
   * matches while the vector lane recalls semantically similar rows
   * independently, then Reciprocal Rank Fusion merges both ranked lanes.
   */
  async queryAsync(request: RoleMemoryQuery): Promise<RoleMemoryQueryResult> {
    if (!request.text?.trim() || this.options.embedding === undefined) return this.query(request)
    const scope = normalizedScope(request.scope)
    // Keyword lane: deterministic literal matches, newest first.
    const keywordItems = this.query({ ...request, limit: MAX_LIMIT }).records
    let queryEmbedding: number[]
    try {
      queryEmbedding = await embedText(this.options.embedding, request.text)
    } catch {
      // Semantic retrieval is an enhancement; an unavailable embedding
      // endpoint degrades to the deterministic keyword path instead of failing.
      return this.query(request)
    }
    // Vector lane: independent semantic recall across every active row in scope.
    const kinds = request.kinds === undefined ? undefined : new Set(request.kinds.map(kind => kind.trim()).filter(Boolean))
    const domains = request.domains === undefined ? undefined : new Set(request.domains)
    const vectorItems = [...this.table.entries()]
      .map(([id, record]) => this.toMemory(id, record))
      .filter(record => record.status === 'active')
      .filter(record => record.scope.roleId === scope.roleId)
      .filter(record => request.requireScopeMatch !== true || scopeMatches(record, scope))
      .filter(record => kinds === undefined || kinds.has(record.kind))
      .filter(record => domains === undefined || domains.has(record.domain))
      .map(record => ({ record, score: cosine(queryEmbedding, record.embedding ?? []) }))
      .filter(item => item.score >= VECTOR_SCORE_THRESHOLD)
      .sort((left, right) => right.score - left.score)
      .slice(0, VECTOR_LANE_LIMIT)
    const ranked = rrfMerge(keywordItems, vectorItems, limited(request.limit))
    return {
      textBlock: this.renderContextBlock(ranked),
      records: ranked,
      trace: { engine: 'shiori-role', intent: request.intent ?? 'answer', effect: request.effect ?? 'read_only', retrieval: 'hybrid-rrf' },
    }
  }

  /** Apply a remember or forget mutation and report the affected durable ids. */
  async mutate(request: RoleMemoryMutation): Promise<RoleMemoryMutationResult> {
    const scope = normalizedScope(request.scope)
    if (request.kind === 'forget') {
      const affectedIds: string[] = []
      const missingIds: string[] = []
      for (const id of request.ids.map(value => value.trim()).filter(Boolean)) {
        if (await this.forget(scope.roleId, id)) affectedIds.push(id)
        else missingIds.push(id)
      }
      for (const sourceRef of (request.sourceRefs ?? []).map(value => value.trim()).filter(Boolean)) {
        for (const [id, record] of this.table.entries()) {
          if (record.roleId === scope.roleId && (record.sourceRef === sourceRef || record.extra.sourceRef === sourceRef)) {
            if (await this.forget(scope.roleId, id)) affectedIds.push(id)
          }
        }
      }
      return {
        accepted: affectedIds.length > 0,
        status: affectedIds.length > 0 ? 'forgotten' : 'not_found',
        affectedIds,
        missingIds,
      }
    }

    const summary = request.summary.trim()
    if (!summary) throw new Error('shiori-role: memory summary must not be empty')
    const kind = request.memoryKind?.trim() || 'fact'
    const domain = normalizedDomain(request.memoryDomain)
    const hash = contentHash(summary)
    const embedding = this.options.embedding === undefined
      ? undefined
      : await embedText(this.options.embedding, summary).catch(() => undefined)
    const duplicate = [...this.table.entries()]
      .map(([id, record]) => this.toMemory(id, record))
      .find(record => record.status === 'active'
        && record.scope.roleId === scope.roleId
        && record.kind === kind
        && record.domain === domain
        && record.contentHash === hash)
    if (duplicate !== undefined) {
      const updated = this.toStored({
        ...duplicate,
        reinforcementCount: duplicate.reinforcementCount + 1,
        updatedAt: new Date().toISOString(),
      })
      await this.table.put(duplicate.id, updated)
      const item = this.toMemory(duplicate.id, updated)
      return { accepted: true, status: 'reinforced', item, affectedIds: [item.id], missingIds: [] }
    }

    const now = new Date().toISOString()
    const id = this.nextId(scope.roleId)
    const stored: StoredRoleMemoryRecord = {
      roleId: scope.roleId,
      summary,
      contentHash: hash,
      ...(embedding === undefined ? {} : { embedding }),
      extra: {
        roleId: scope.roleId,
        memoryDomain: domain,
        ...(scope.channel === undefined ? {} : { scopeChannel: scope.channel }),
        ...(scope.chatId === undefined ? {} : { scopeChatId: scope.chatId }),
        ...(request.extra ?? {}),
      },
      content: summary,
      kind,
      memoryType: kind,
      domain,
      scope: {
        ...(scope.sessionKey === undefined ? {} : { sessionKey: scope.sessionKey }),
        ...(scope.channel === undefined ? {} : { channel: scope.channel }),
        ...(scope.chatId === undefined ? {} : { chatId: scope.chatId }),
      },
      sourceRef: request.sourceRef?.trim() ?? '',
      happenedAt: request.happenedAt?.trim() ?? '',
      evidence: (request.evidence ?? []).map(item => ({
        kind: item.kind,
        refs: [...item.refs],
        ...(item.sourceRef === undefined ? {} : { sourceRef: item.sourceRef }),
      })),
      status: 'active',
      reinforcementCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    await this.table.put(id, stored)
    const item = this.toMemory(id, stored)
    return { accepted: true, status: 'new', item, affectedIds: [id], missingIds: [] }
  }

  /** Compatibility facade for saving one role-owned fact. */
  async memorize(roleId: string, content: string): Promise<RoleMemory> {
    const result = await this.mutate({ kind: 'remember', scope: { roleId }, summary: content })
    if (result.item === undefined) throw new Error('shiori-role: remember mutation returned no memory')
    return result.item
  }

  /**
   * Persist post-turn extraction candidates under one source reference.
   *
   * Duplicate summaries are reinforced by the same content-hash rule as
   * explicit memorization; a malformed candidate is skipped without failing
   * the remaining ones. Shiori extraction fields (emotional_weight, category,
   * tool_requirement, steps) ride in `extra` like Shiori's memory_items.
   */
  async saveExtracted(
    scope: RoleMemoryScope,
    sourceRef: string,
    items: readonly ExtractedMemory[],
    evidence?: readonly RoleMemoryEvidence[],
  ): Promise<RoleMemoryMutationResult[]> {
    const results: RoleMemoryMutationResult[] = []
    for (const item of items) {
      const summary = item.summary?.trim()
      if (!summary) continue
      const extra: Record<string, string> = {}
      if (item.emotionalWeight !== undefined) {
        extra.emotional_weight = String(Math.max(0, Math.min(10, Math.round(item.emotionalWeight))))
      }
      if (item.category?.trim()) extra.category = item.category.trim()
      if (item.toolRequirement?.trim()) extra.tool_requirement = item.toolRequirement.trim()
      if (item.steps !== undefined && item.steps.length > 0) extra.steps = JSON.stringify(item.steps)
      try {
        results.push(await this.mutate({
          kind: 'remember',
          scope,
          summary,
          ...(item.kind?.trim() ? { memoryKind: item.kind.trim() } : {}),
          ...(item.domain === undefined ? {} : { memoryDomain: item.domain }),
          ...(item.happenedAt?.trim() ? { happenedAt: item.happenedAt.trim() } : {}),
          sourceRef,
          ...(Object.keys(extra).length === 0 ? {} : { extra }),
          ...(evidence === undefined ? {} : { evidence }),
        }))
      } catch {
        // One invalid candidate must not abort the whole extraction batch.
      }
    }
    return results
  }

  /** Compatibility facade for recent role-owned memories. */
  recall(roleId: string, text?: string, limit = DEFAULT_LIMIT): RoleMemory[] {
    return [...this.query({
      scope: { roleId },
      ...(text === undefined ? {} : { text }),
      limit,
    }).records]
  }

  /** Delete one memory only when it belongs to the selected role. */
  async forget(roleId: string, id: string): Promise<boolean> {
    const record = this.table.get(id)
    if (record?.roleId !== roleId) return false
    return this.table.delete(id)
  }

  /** Remove all active and historical rows sourced from one turn or event. */
  async forgetBySourceRef(roleId: string, sourceRef: string): Promise<readonly string[]> {
    const ids: string[] = []
    for (const [id, record] of this.table.entries()) {
      if (record.roleId === roleId && (record.sourceRef === sourceRef || record.extra.sourceRef === sourceRef)) {
        if (await this.forget(roleId, id)) ids.push(id)
      }
    }
    return ids
  }

  /** Remove every durable row owned by a role when its workspace entry is deleted. */
  async forgetRole(roleId: string): Promise<readonly string[]> {
    const ids = [...this.table.entries()]
      .filter(([, record]) => record.roleId === roleId)
      .map(([id]) => id)
    for (const id of ids) await this.forget(roleId, id)
    return ids
  }

  /** Build the model-facing current-memory snapshot for one bound role. */
  context(scope: RoleMemoryScope, limit = 8): string {
    const markdown = 'readMarkdown' in this.table
      ? (this.table as KvTable<string, StoredRoleMemoryRecord> & MarkdownMemoryTable).readMarkdown(scope.roleId).trim()
      : ''
    if (markdown) return `## Long-term Memory\n${markdown}`
    return this.query({ scope, intent: 'context', effect: 'read_only', limit }).textBlock
  }

  private renderContextBlock(records: readonly RoleMemory[]): string {
    if (records.length === 0) return ''
    const rows = records.map(record => `- [${record.id}] (${record.kind}/${record.domain}) ${record.summary}`)
    return ['Role memory relevant to this agent:', ...rows].join('\n')
  }

  private toMemory(id: string, record: StoredRoleMemoryRecord): RoleMemory {
    return {
      id,
      summary: record.summary ?? record.content,
      memoryType: record.memoryType ?? record.kind,
      contentHash: record.contentHash || contentHash(record.summary ?? record.content),
      ...(record.embedding === undefined ? {} : { embedding: [...record.embedding] }),
      extra: { ...record.extra },
      kind: record.memoryType ?? record.kind,
      domain: record.domain,
      scope: {
        roleId: record.roleId,
        ...(record.scope.sessionKey === undefined ? {} : { sessionKey: record.scope.sessionKey }),
        ...(record.scope.channel === undefined ? {} : { channel: record.scope.channel }),
        ...(record.scope.chatId === undefined ? {} : { chatId: record.scope.chatId }),
      },
      ...(record.sourceRef ? { sourceRef: record.sourceRef } : {}),
      ...(record.happenedAt ? { happenedAt: record.happenedAt } : {}),
      evidence: record.evidence.map(item => ({
        kind: item.kind,
        refs: [...item.refs],
        ...(item.sourceRef === undefined ? {} : { sourceRef: item.sourceRef }),
      })),
      status: record.status,
      reinforcementCount: record.reinforcementCount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  private toStored(record: RoleMemory): StoredRoleMemoryRecord {
    const { roleId, ...scope } = record.scope
    return {
      roleId,
      summary: record.summary,
      contentHash: record.contentHash,
      ...(record.embedding === undefined ? {} : { embedding: [...record.embedding] }),
      extra: { ...record.extra },
      content: record.summary,
      kind: record.kind,
      memoryType: record.memoryType,
      domain: record.domain,
      scope: {
        ...(scope.sessionKey === undefined ? {} : { sessionKey: scope.sessionKey }),
        ...(scope.channel === undefined ? {} : { channel: scope.channel }),
        ...(scope.chatId === undefined ? {} : { chatId: scope.chatId }),
      },
      sourceRef: record.sourceRef ?? '',
      happenedAt: record.happenedAt ?? '',
      evidence: record.evidence.map(item => ({
        kind: item.kind,
        refs: [...item.refs],
        ...(item.sourceRef === undefined ? {} : { sourceRef: item.sourceRef }),
      })),
      status: record.status,
      reinforcementCount: record.reinforcementCount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  private nextId(roleId: string): string {
    let id: string
    do {
      this.idSequence += 1
      id = `${roleId}:${Date.now().toString(36)}-${this.idSequence.toString(36)}`
    } while (this.table.get(id) !== undefined)
    return id
  }
}

function memoryToJson(memory: RoleMemory): JsonValue {
  return {
    id: memory.id,
    summary: memory.summary,
    memoryType: memory.memoryType,
    contentHash: memory.contentHash,
    ...(memory.embedding === undefined ? {} : { embedding: [...memory.embedding] }),
    extra: { ...memory.extra },
    kind: memory.kind,
    domain: memory.domain,
    scope: {
      roleId: memory.scope.roleId,
      ...(memory.scope.sessionKey === undefined ? {} : { sessionKey: memory.scope.sessionKey }),
      ...(memory.scope.channel === undefined ? {} : { channel: memory.scope.channel }),
      ...(memory.scope.chatId === undefined ? {} : { chatId: memory.scope.chatId }),
    },
    ...(memory.sourceRef === undefined ? {} : { sourceRef: memory.sourceRef }),
    ...(memory.happenedAt === undefined ? {} : { happenedAt: memory.happenedAt }),
    evidence: memory.evidence.map(item => ({
      kind: item.kind,
      refs: [...item.refs],
      ...(item.sourceRef === undefined ? {} : { sourceRef: item.sourceRef }),
    })),
    status: memory.status,
    reinforcementCount: memory.reinforcementCount,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  }
}

function queryResultToJson(result: RoleMemoryQueryResult): JsonValue {
  return {
    textBlock: result.textBlock,
    records: result.records.map(memoryToJson),
    trace: { ...result.trace },
  }
}

function mutationResultToJson(result: RoleMemoryMutationResult): JsonValue {
  return {
    accepted: result.accepted,
    status: result.status,
    ...(result.item === undefined ? {} : { item: memoryToJson(result.item) }),
    affectedIds: [...result.affectedIds],
    missingIds: [...result.missingIds],
  }
}

async function embedText(config: MemoryEmbeddingConfig, text: string): Promise<number[]> {
  const response = await fetch(config.endpoint.replace(/\/$/, '') + '/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
    body: JSON.stringify({ model: config.model, input: text.slice(0, 2000) }),
  })
  if (!response.ok) throw new Error(`shiori-role: embedding request failed (${response.status})`)
  const payload = await response.json() as { data?: Array<{ embedding?: unknown }> }
  const embedding = payload.data?.[0]?.embedding
  if (!Array.isArray(embedding) || embedding.some(value => typeof value !== 'number')) throw new Error('shiori-role: embedding response is invalid')
  return embedding as number[]
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!
    leftNorm += left[index]! ** 2
    rightNorm += right[index]! ** 2
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm)
}

/** Merge keyword and vector ranked lanes, mirrored from Shiori's `_rrf_merge`. */
function rrfMerge(
  keywordItems: readonly RoleMemory[],
  vectorItems: readonly { record: RoleMemory; score: number }[],
  topN: number,
): RoleMemory[] {
  const keywordRank = new Map(keywordItems.map((record, index) => [record.id, index + 1]))
  const vectorRank = new Map(vectorItems.map((item, index) => [item.record.id, index + 1]))
  const byId = new Map<string, RoleMemory>()
  for (const record of keywordItems) byId.set(record.id, record)
  for (const item of vectorItems) byId.set(item.record.id, item.record)
  const scored: { id: string; rrf: number }[] = []
  for (const id of new Set([...keywordRank.keys(), ...vectorRank.keys()])) {
    let rrf = 0
    const vectorPosition = vectorRank.get(id)
    if (vectorPosition !== undefined) rrf += 1 / (RRF_K + vectorPosition)
    const keywordPosition = keywordRank.get(id)
    if (keywordPosition !== undefined) rrf += KEYWORD_RRF_WEIGHT / (RRF_K + keywordPosition)
    scored.push({ id, rrf })
  }
  scored.sort((left, right) => right.rrf - left.rrf)
  return scored.slice(0, topN).flatMap(item => {
    const record = byId.get(item.id)
    return record === undefined ? [] : [record]
  })
}

const EXTRACTION_SYSTEM_PROMPT = '你是中性的长期记忆提取器，不扮演角色，也不生成用户可见回复。'

/** Extraction instruction, condensed from Shiori's `_build_long_term_prompt`. */
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
  · "你还记得我什么时候开始戴 fitbit 手环的吗" → 返回空
  · "你记得我住哪里吗" → 返回空
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

/** Extract Shiori-style long-term memory candidates from one turn conversation. */
export async function extractMemories(
  config: MemoryExtractionConfig,
  conversation: string,
  existingProfile = '',
): Promise<ExtractedMemory[]> {
  const response = await fetch(config.endpoint.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: extractionPrompt(conversation.slice(0, 12_000), existingProfile) },
      ],
    }),
  })
  if (!response.ok) throw new Error(`shiori-role: extraction request failed (${response.status})`)
  const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
  const content = payload.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('shiori-role: extraction response is invalid')
  return parseExtractionPayload(content)
}

/** Tolerantly parse a Shiori extraction object, including fenced output. */
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

/** Mount role memory tools and a current-memory context into an Agent scope. */
export function applyMemoryTools(
  ctx: Context,
  memory: ShioriMemoryService,
  input: string | RoleMemoryScope | (() => RoleMemoryScope),
): void {
  const scope = () => normalizedScope(
    typeof input === 'function' ? input() : typeof input === 'string' ? { roleId: input } : input,
  )
  ctx.systemPrompt.context({
    name: 'shiori-role:memory',
    order: MEMORY_CONTEXT_ORDER,
    text: () => memory.context(scope()),
  })
  ctx.tools.register(defineTool({
    name: 'recall_memory',
    description: 'Recall structured durable memories belonging only to the currently bound role.',
    parameters: {
      query: { type: 'string', description: 'Optional case-insensitive text filter.' },
      limit: { type: 'number', description: 'Optional maximum number of results, from 1 to 50.' },
      kind: { type: 'string', description: 'Optional memory kind filter.' },
      domain: { type: 'string', description: 'Optional role_self, relationship, or shared domain filter.' },
    },
    output: MEMORY_OUTPUT,
    execute: async args => queryResultToJson(await memory.queryAsync({
      scope: scope(),
      ...(args.query === undefined ? {} : { text: args.query }),
      ...(args.kind === undefined ? {} : { kinds: [args.kind] }),
      ...(args.domain === undefined ? {} : { domains: [normalizedDomain(args.domain)] }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
      intent: 'answer',
      effect: 'read_only',
    })),
  }))
  ctx.tools.register(defineTool({
    name: 'memorize',
    description: 'Save or reinforce a structured durable memory for the currently bound role.',
    parameters: {
      content: { type: 'string', required: true, description: 'Memory summary to retain.' },
      kind: { type: 'string', description: 'Optional memory kind, such as fact, event, preference, profile, or procedure.' },
      domain: { type: 'string', description: 'Optional role_self, relationship, or shared domain.' },
      sourceRef: { type: 'string', description: 'Optional source or turn reference.' },
    },
    output: MEMORY_OUTPUT,
    execute: async args => mutationResultToJson(await memory.mutate({
      kind: 'remember',
      scope: scope(),
      summary: args.content,
      ...(args.kind === undefined ? {} : { memoryKind: args.kind }),
      ...(args.domain === undefined ? {} : { memoryDomain: normalizedDomain(args.domain) }),
      ...(args.sourceRef === undefined ? {} : { sourceRef: args.sourceRef }),
    })),
  }))
  ctx.tools.register(defineTool({
    name: 'forget_memory',
    description: 'Delete a durable memory by id when it belongs to the currently bound role.',
    parameters: { id: { type: 'string', required: true, description: 'Memory id returned by recall_memory or memorize.' } },
    output: MEMORY_OUTPUT,
    execute: async args => mutationResultToJson(await memory.mutate({ kind: 'forget', scope: scope(), ids: [args.id] })),
  }))
}
