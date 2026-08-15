/**
 * 记忆工具注册（recall_memory / memorize / forget_memory）与上下文注入。
 * 对齐现有 dsh 插件工具契约，后端换成 DefaultMemoryEngine。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { RoleMemoryDomain, RoleMemoryScope } from '../memory-contract.ts'
import type { DefaultMemoryEngine } from './engine.ts'

export type MemoryToolsEngine = Pick<DefaultMemoryEngine, 'query' | 'mutate' | 'contextText'>

const MEMORY_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: JSON.stringify(value),
  }],
}

const MEMORY_CONTEXT_ORDER = 100

function normalizedScope(input: string | RoleMemoryScope | (() => RoleMemoryScope)): RoleMemoryScope {
  const raw = typeof input === 'function' ? input() : typeof input === 'string' ? { roleId: input } : input
  const roleId = raw.roleId.trim()
  if (!roleId) throw new Error('shiori-role: memory scope requires a role id')
  return {
    roleId,
    ...(raw.sessionKey?.trim() ? { sessionKey: raw.sessionKey.trim() } : {}),
    ...(raw.channel?.trim() ? { channel: raw.channel.trim() } : {}),
    ...(raw.chatId?.trim() ? { chatId: raw.chatId.trim() } : {}),
  }
}

function normalizedDomain(value?: string): RoleMemoryDomain {
  if (value === undefined || value === '') return 'role_self'
  if (value === 'role_self' || value === 'relationship' || value === 'shared') return value
  throw new Error(`shiori-role: unknown memory domain '${value}'`)
}

/** 解析 time_filter（today / yesterday / recent_3d / recent_7d / recent_30d / YYYY-MM-DD / YYYY-MM-DD~YYYY-MM-DD）。 */
function parseTimeFilter(value: string): { timeStart?: string; timeEnd?: string } {
  const raw = value.trim()
  if (!raw) return {}
  const now = new Date()
  const daysAgoStart = (days: number) => {
    const date = new Date(now.getTime() - days * 86_400_000)
    return date.toISOString().slice(0, 10)
  }
  if (raw === 'today') return { timeStart: now.toISOString().slice(0, 10) }
  if (raw === 'yesterday') {
    return { timeStart: daysAgoStart(1), timeEnd: daysAgoStart(0) }
  }
  const recent = raw.match(/^recent_(\d+)d$/)
  if (recent) return { timeStart: daysAgoStart(Number.parseInt(recent[1]!, 10)) }
  const range = raw.split('~')
  if (range.length === 2 && range[0] && range[1]) {
    return { timeStart: range[0], timeEnd: range[1] }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { timeStart: raw }
  return {}
}

/** Mount role memory tools and a current-memory context into an Agent scope. */
export function applyMemoryTools(
  ctx: Context,
  engine: MemoryToolsEngine,
  input: string | RoleMemoryScope | (() => RoleMemoryScope),
): void {
  const scope = () => normalizedScope(input)
  ctx.systemPrompt.context({
    name: 'shiori-role:memory',
    order: MEMORY_CONTEXT_ORDER,
    text: () => engine.contextText(scope()),
  })
  ctx.tools.register(defineTool({
    name: 'recall_memory',
    description: 'Recall structured durable memories belonging only to the currently bound role.',
    parameters: {
      query: { type: 'string', description: 'Optional case-insensitive text filter.' },
      limit: { type: 'number', description: 'Optional maximum number of results, from 1 to 50.' },
      kind: { type: 'string', description: 'Optional memory kind filter.' },
      domain: { type: 'string', description: 'Optional role_self, relationship, or shared domain filter.' },
      intent: { type: 'string', enum: ['answer', 'timeline'], description: 'answer=thematic retrieval; timeline=recall by time range.', default: 'answer' },
      time_filter: { type: 'string', description: 'today / yesterday / recent_3d / recent_7d / recent_30d / YYYY-MM-DD / YYYY-MM-DD~YYYY-MM-DD', default: '' },
    },
    output: MEMORY_OUTPUT,
    execute: async args => queryResultToJson(await engine.query({
      text: String(args.query ?? ''),
      intent: args.intent === 'timeline' ? 'timeline' : 'answer',
      scope: scope(),
      ...(args.kind === undefined ? {} : { filters: { kinds: [String(args.kind)] } }),
      ...(args.domain === undefined ? {} : { filters: { domains: [normalizedDomain(String(args.domain))] } }),
      ...(args.time_filter ? { filters: parseTimeFilter(String(args.time_filter)) } : {}),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
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
    execute: async args => mutationResultToJson(await engine.mutate({
      kind: 'remember',
      scope: scope(),
      summary: String(args.content),
      ...(args.kind === undefined ? {} : { memoryKind: String(args.kind) }),
      ...(args.domain === undefined ? {} : { memoryDomain: normalizedDomain(String(args.domain)) }),
      ...(args.sourceRef === undefined ? {} : { sourceRef: String(args.sourceRef) }),
    })),
  }))
  ctx.tools.register(defineTool({
    name: 'forget_memory',
    description: 'Delete a durable memory by id when it belongs to the currently bound role.',
    parameters: { id: { type: 'string', required: true, description: 'Memory id returned by recall_memory or memorize.' } },
    output: MEMORY_OUTPUT,
    execute: async args => mutationResultToJson(await engine.mutate({ kind: 'forget', scope: scope(), ids: [String(args.id)] })),
  }))
}

function queryResultToJson(result: Awaited<ReturnType<DefaultMemoryEngine['query']>>): JsonValue {
  return {
    textBlock: result.textBlock ?? '',
    records: result.records.map(record => ({
      id: record.id,
      kind: record.kind,
      summary: record.summary,
      score: record.score,
      engine_kind: record.engineKind,
      ...(record.domain === undefined ? {} : { domain: record.domain }),
      evidence: (record.evidence ?? []).map(evidence => ({
        kind: evidence.kind,
        refs: [...(evidence.refs ?? [])],
        ...(evidence.sourceRef === undefined ? {} : { source_ref: evidence.sourceRef }),
      })),
      signals: JSON.parse(JSON.stringify(record.signals ?? {})) as Record<string, JsonValue>,
      injected: record.injected ?? false,
    })),
    trace: JSON.parse(JSON.stringify(result.trace ?? {})) as Record<string, JsonValue>,
  }
}

function mutationResultToJson(result: Awaited<ReturnType<DefaultMemoryEngine['mutate']>>): JsonValue {
  return {
    accepted: result.accepted,
    status: result.status ?? '',
    ...(result.itemId === undefined ? {} : { itemId: result.itemId }),
    ...(result.actualKind === undefined ? {} : { actualKind: result.actualKind }),
    affectedIds: [...(result.affectedIds ?? [])],
    missingIds: [...(result.missingIds ?? [])],
  }
}
