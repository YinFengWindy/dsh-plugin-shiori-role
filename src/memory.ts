import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  RoleMemory,
  RoleMemoryDomain,
  RoleMemoryMutation,
  RoleMemoryMutationResult,
  RoleMemoryQuery,
  RoleMemoryQueryIntent,
  RoleMemoryQueryResult,
  RoleMemoryScope,
} from './memory-contract.ts'
import type { StoredRoleMemoryRecord } from './spec.ts'

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

  constructor(private readonly table: KvTable<string, StoredRoleMemoryRecord>) {}

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
    const duplicate = [...this.table.entries()]
      .map(([id, record]) => this.toMemory(id, record))
      .find(record => record.status === 'active'
        && record.scope.roleId === scope.roleId
        && record.kind === kind
        && record.domain === domain
        && record.summary.toLocaleLowerCase() === summary.toLocaleLowerCase())
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
      content: summary,
      kind,
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

  /** Build the model-facing current-memory snapshot for one bound role. */
  context(scope: RoleMemoryScope, limit = 8): string {
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
      summary: record.content,
      kind: record.kind,
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
      content: record.summary,
      kind: record.kind,
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
    execute: async args => queryResultToJson(memory.query({
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
