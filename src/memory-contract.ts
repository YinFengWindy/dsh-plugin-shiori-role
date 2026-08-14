/** Memory domains mirrored from Shiori's default-memory contract. */
export type RoleMemoryDomain = 'role_self' | 'relationship' | 'shared'

/** Query intents mirrored from Shiori's default-memory contract. */
export type RoleMemoryQueryIntent = 'context' | 'answer' | 'timeline' | 'interest' | 'procedure'

/** A role-owned memory scope. Harness currently fills role and session fields. */
export interface RoleMemoryScope {
  readonly roleId: string
  readonly sessionKey?: string
  readonly channel?: string
  readonly chatId?: string
}

/** Durable evidence pointer attached to one memory. */
export interface RoleMemoryEvidence {
  readonly kind: 'message' | 'message_range' | 'turn' | 'external'
  readonly refs: readonly string[]
  readonly sourceRef?: string
}

/** Public memory row returned by queries and mutations. */
export interface RoleMemory {
  readonly id: string
  readonly summary: string
  /** Shiori memory_items memory_type, retained alongside the legacy kind alias. */
  readonly memoryType: string
  readonly contentHash: string
  readonly embedding?: readonly number[]
  readonly extra: Readonly<Record<string, string>>
  readonly kind: string
  readonly domain: RoleMemoryDomain
  readonly scope: RoleMemoryScope
  readonly sourceRef?: string
  readonly happenedAt?: string
  readonly evidence: readonly RoleMemoryEvidence[]
  readonly status: 'active' | 'superseded'
  readonly reinforcementCount: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** Structured role-memory query. */
export interface RoleMemoryQuery {
  readonly text?: string
  readonly intent?: RoleMemoryQueryIntent
  readonly effect?: 'stateful' | 'read_only'
  readonly scope: RoleMemoryScope
  readonly kinds?: readonly string[]
  readonly domains?: readonly RoleMemoryDomain[]
  readonly requireScopeMatch?: boolean
  readonly limit?: number
}

/** Deterministic query result; semantic ranking is intentionally deferred. */
export interface RoleMemoryQueryResult {
  readonly textBlock: string
  readonly records: readonly RoleMemory[]
  readonly trace: {
    readonly engine: 'shiori-role'
    readonly intent: RoleMemoryQueryIntent
    readonly effect: 'stateful' | 'read_only'
    readonly retrieval: 'deterministic-text' | 'hybrid-rrf'
  }
}

/** Structured remember/forget mutation. */
export type RoleMemoryMutation =
  | {
      readonly kind: 'remember'
      readonly scope: RoleMemoryScope
      readonly summary: string
      readonly memoryKind?: string
      readonly memoryDomain?: RoleMemoryDomain
      readonly sourceRef?: string
      readonly happenedAt?: string
      readonly evidence?: readonly RoleMemoryEvidence[]
      readonly extra?: Readonly<Record<string, string>>
    }
  | {
      readonly kind: 'forget'
      readonly scope: RoleMemoryScope
      readonly ids: readonly string[]
      readonly sourceRefs?: readonly string[]
    }

/** Result of one structured memory mutation. */
export interface RoleMemoryMutationResult {
  readonly accepted: boolean
  readonly status: 'new' | 'reinforced' | 'forgotten' | 'not_found'
  readonly item?: RoleMemory
  readonly affectedIds: readonly string[]
  readonly missingIds: readonly string[]
}
