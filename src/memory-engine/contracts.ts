/**
 * Shiori `core/memory/engine.py` + `core/memory/events.py` contracts,
 * ported 1:1 to TypeScript.
 */

/** Query intents, mirrored from Shiori. */
export type MemoryQueryIntent = 'context' | 'answer' | 'timeline' | 'interest' | 'procedure'
export type MemoryQueryEffect = 'stateful' | 'read_only'
export type MemoryDomain = 'role_self' | 'relationship' | 'shared'

export type MemoryEngineProfile = 'rich_memory_engine' | 'classic_memory_service' | 'workflow_memory_engine' | 'context_resource_engine'

export type MemoryCapability =
  | 'ingest.text'
  | 'ingest.messages'
  | 'ingest.resource'
  | 'retrieve.semantic'
  | 'retrieve.context_block'
  | 'retrieve.structured_hits'
  | 'manage.history'
  | 'manage.update'
  | 'manage.delete'
  | 'enrich.graph_relations'
  | 'semantics.rich_memory'

export interface MemoryEngineDescriptor {
  readonly name: string
  readonly profile: MemoryEngineProfile
  readonly capabilities: ReadonlySet<MemoryCapability>
  readonly notes?: Readonly<Record<string, unknown>>
}

/** Role memory scope, mirrored from Shiori's `MemoryScope`. */
export interface MemoryScope {
  readonly roleId?: string
  readonly sessionKey?: string
  readonly channel?: string
  readonly chatId?: string
}

/** Evidence pointer attached to a query result record. */
export interface EvidenceRef {
  readonly kind: 'message' | 'message_range' | 'turn' | 'external'
  readonly refs?: readonly string[]
  readonly resolver?: string
  readonly sourceRef?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** One query result record. */
export interface MemoryRecord {
  readonly id: string
  readonly kind: string
  readonly summary: string
  readonly score: number
  readonly engineKind: string
  readonly evidence?: readonly EvidenceRef[]
  readonly signals?: Readonly<Record<string, unknown>>
  readonly domain?: string
  readonly injected?: boolean
}

/** Query filters, mirrored from Shiori's `MemoryQueryFilters`. */
export interface MemoryQueryFilters {
  readonly kinds?: readonly string[]
  readonly domains?: readonly MemoryDomain[]
  readonly timeStart?: string
  readonly timeEnd?: string
  readonly hints?: Readonly<Record<string, unknown>>
}

/** Structured memory query. */
export interface MemoryQuery {
  readonly text: string
  readonly intent?: MemoryQueryIntent
  readonly effect?: MemoryQueryEffect
  readonly scope?: MemoryScope
  readonly filters?: MemoryQueryFilters
  readonly context?: Readonly<Record<string, unknown>>
  readonly limit?: number
  readonly timestamp?: string
}

/** Query result. */
export interface MemoryQueryResult {
  readonly textBlock?: string
  readonly records: readonly MemoryRecord[]
  readonly trace?: Readonly<Record<string, unknown>>
  readonly raw?: Readonly<Record<string, unknown>>
}

/** Structured remember/forget mutation, mirrored from Shiori. */
export interface MemoryMutation {
  readonly kind: 'remember' | 'forget'
  readonly scope?: MemoryScope
  readonly summary?: string
  readonly memoryKind?: string
  readonly memoryDomain?: string
  readonly sourceRef?: string
  readonly happenedAt?: string
  readonly ids?: readonly string[]
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface MemoryMutationResult {
  readonly accepted: boolean
  readonly itemId?: string
  readonly actualKind?: string
  readonly status?: string
  readonly affectedIds?: readonly string[]
  readonly missingIds?: readonly string[]
  readonly items?: readonly Readonly<Record<string, unknown>>[]
  readonly raw?: Readonly<Record<string, unknown>>
}

/** Ingest request (conversation turn / batch). */
export interface MemoryIngestRequest {
  readonly content: unknown
  readonly sourceKind: string
  readonly scope?: MemoryScope
  readonly hints?: Readonly<Record<string, unknown>>
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface MemoryIngestResult {
  readonly accepted: boolean
  readonly createdIds?: readonly string[]
  readonly summary?: string
  readonly raw?: Readonly<Record<string, unknown>>
}

/** Durable memory item row, mirrored from `memory2/models.py`. */
export interface MemoryItem {
  readonly id: string
  readonly memoryType: string
  readonly summary: string
  readonly contentHash: string
  readonly embedding?: readonly number[]
  readonly reinforcement: number
  readonly emotionalWeight: number
  readonly extraJson: Readonly<Record<string, unknown>>
  readonly sourceRef?: string
  readonly happenedAt?: string
  readonly status: 'active' | 'superseded'
  readonly createdAt: string
  readonly updatedAt: string
}

/** One retrieval hit from the store. */
export interface StoreHit {
  readonly id: string
  readonly memoryType: string
  readonly memoryDomain?: string | undefined
  readonly summary: string
  readonly extraJson: Readonly<Record<string, unknown>>
  readonly happenedAt?: string | undefined
  readonly sourceRef?: string | undefined
  /** Vector lane score; absent on keyword-only hits (keywordScore is used instead). */
  readonly score?: number | undefined
  readonly keywordScore?: number | undefined
  readonly scoreDebug?: { readonly semantic: number; readonly hotness: number; readonly final: number } | undefined
  readonly forced?: boolean | undefined
  readonly confidenceLabel?: string | undefined
  readonly [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Events (core/memory/events.py)
// ---------------------------------------------------------------------------

export interface RetrievalHitSummary {
  readonly itemId: string
  readonly memoryType: string
  readonly score: number
  readonly summary: string
  readonly injected: boolean
  readonly confidenceLabel?: string
  readonly forced?: boolean
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface RetrievalCompleted {
  readonly sessionKey: string
  readonly channel: string
  readonly chatId: string
  readonly query: string
  readonly origQuery?: string
  readonly hits: readonly RetrievalHitSummary[]
  readonly injectedCount: number
  readonly routeDecision?: string
  readonly auxQueries?: readonly string[]
  readonly error?: string
  readonly roleId?: string
}

export interface MemoryWritten {
  readonly sessionKey: string
  readonly channel: string
  readonly chatId: string
  readonly action: 'write' | 'supersede'
  readonly sourceRef: string
  readonly memoryType?: string
  readonly itemId?: string
  readonly summary?: string
  readonly supersededIds?: readonly string[]
  readonly error?: string
  readonly roleId?: string
}

export interface TurnIngested {
  readonly sessionKey: string
  readonly channel: string
  readonly chatId: string
  readonly userMessage: string
  readonly assistantResponse: string
  readonly toolChain: readonly Readonly<Record<string, unknown>>[]
  readonly sourceRef: string
  readonly roleId?: string
}

export interface ConsolidationCommitted {
  readonly historyEntryPayloads: readonly (readonly [string, number])[]
  readonly sourceRef: string
  readonly scopeChannel: string
  readonly scopeChatId: string
  readonly conversation: string
  readonly roleId?: string
}

// ---------------------------------------------------------------------------
// Engine / tool contracts
// ---------------------------------------------------------------------------

export interface MemoryToolSpec {
  readonly name?: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly risk?: 'read-only' | 'write' | 'external-side-effect'
  readonly searchHint?: string
}

export interface MemoryToolProfile {
  readonly recall?: MemoryToolSpec
  readonly memorize?: MemoryToolSpec
  readonly forget?: MemoryToolSpec
  readonly tools?: readonly MemoryToolSpec[]
}

/** Admin-facing store operations. */
export interface MemoryAdminApi {
  listItemsForAdmin(options?: {
    q?: string | undefined
    memoryType?: string | undefined
    memoryDomain?: string | undefined
    status?: string | undefined
    sourceRef?: string | undefined
    roleId?: string | undefined
    scopeChannel?: string | undefined
    scopeChatId?: string | undefined
    hasEmbedding?: boolean | undefined
    page?: number | undefined
    pageSize?: number | undefined
    sortBy?: string | undefined
    sortOrder?: 'asc' | 'desc' | undefined
  }): { readonly items: readonly Readonly<Record<string, unknown>>[]; readonly total: number }
  getItemForAdmin(itemId: string, includeEmbedding?: boolean): Readonly<Record<string, unknown>> | undefined
  updateItemForAdmin(itemId: string, patch: {
    status?: 'active' | 'superseded' | undefined
    extraJson?: Readonly<Record<string, unknown>> | undefined
    sourceRef?: string | undefined
    happenedAt?: string | undefined
    emotionalWeight?: number | undefined
  }): Readonly<Record<string, unknown>> | undefined
  deleteItem(itemId: string): boolean
  deleteItemsBatch(ids: readonly string[]): number
  invalidateRoleMemories(roleId: string): number
  findSimilarItemsForAdmin(itemId: string, options?: {
    topK?: number | undefined
    memoryType?: string | undefined
    scoreThreshold?: number | undefined
    includeSuperseded?: boolean | undefined
  }): readonly Readonly<Record<string, unknown>>[]
  keywordMatchProcedures(actionTokens: readonly string[]): readonly Readonly<Record<string, unknown>>[]
  listEventsByTimeRange(timeStart: string, timeEnd: string, options?: {
    limit?: number | undefined
    memoryDomains?: readonly string[] | undefined
    roleId?: string | undefined
    scopeChannel?: string | undefined
    scopeChatId?: string | undefined
    requireScopeMatch?: boolean | undefined
  }): readonly Readonly<Record<string, unknown>>[]
}

/** Full memory engine surface. */
export interface MemoryEngine extends MemoryAdminApi {
  readonly descriptor: MemoryEngineDescriptor
  ingest(request: MemoryIngestRequest): Promise<MemoryIngestResult>
  query(request: MemoryQuery): Promise<MemoryQueryResult>
  mutate(request: MemoryMutation): Promise<MemoryMutationResult>
  reinforceItemsBatch(ids: readonly string[]): void
  toolProfile(): MemoryToolProfile
}
