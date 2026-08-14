import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { RoleMemoryRecord } from './spec.ts'

const MEMORY_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: JSON.stringify(value),
  }],
}

/** Role-scoped durable memory service. */
export class ShioriMemoryService {
  constructor(private readonly table: KvTable<string, RoleMemoryRecord>) {}

  /** Store a memory and return its durable id. */
  async memorize(roleId: string, content: string): Promise<RoleMemoryRecord> {
    const normalized = content.trim()
    if (!normalized) throw new Error('shiori-role: memory content must not be empty')
    const now = new Date().toISOString()
    const id = `${roleId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
    const record = { roleId, content: normalized, createdAt: now, updatedAt: now }
    await this.table.put(id, record)
    return record
  }

  /** Return recent memories, optionally filtered by a case-insensitive query. */
  recall(roleId: string, query?: string, limit = 10): RoleMemoryRecord[] {
    const needle = query?.trim().toLocaleLowerCase()
    return [...this.table.entries()]
      .filter(([, record]) => record.roleId === roleId && (needle === undefined || record.content.toLocaleLowerCase().includes(needle)))
      .sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, Math.min(50, Math.floor(limit))))
      .map(([, record]) => record)
  }

  /** Forget one memory only when it belongs to the selected role. */
  async forget(roleId: string, id: string): Promise<boolean> {
    const record = this.table.get(id)
    if (record?.roleId !== roleId) return false
    return this.table.delete(id)
  }
}

/** Mount role memory tools into the current Agent scope. */
export function applyMemoryTools(ctx: Context, memory: ShioriMemoryService, roleId: string): void {
  ctx.systemPrompt.section({
    name: 'shiori-role:memory',
    order: 101,
    text: 'Role memory is isolated to the bound role. Use memorize to save durable facts, recall_memory to retrieve them, and forget_memory to remove an entry.',
  })
  ctx.tools.register(defineTool({
    name: 'recall_memory',
    description: 'Recall recent durable memories belonging only to the currently bound role.',
    parameters: {
      query: { type: 'string', description: 'Optional case-insensitive text filter.' },
      limit: { type: 'number', description: 'Optional maximum number of results, from 1 to 50.' },
    },
    output: MEMORY_OUTPUT,
    execute: args => Promise.resolve({ memories: memory.recall(roleId, args.query, args.limit) }),
  }))
  ctx.tools.register(defineTool({
    name: 'memorize',
    description: 'Save a durable fact for the currently bound role.',
    parameters: { content: { type: 'string', required: true, description: 'Fact to remember.' } },
    output: { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
    execute: async args => ({ memory: await memory.memorize(roleId, args.content) }),
  }))
  ctx.tools.register(defineTool({
    name: 'forget_memory',
    description: 'Delete a durable memory by id when it belongs to the currently bound role.',
    parameters: { id: { type: 'string', required: true, description: 'Memory id returned by recall_memory or memorize.' } },
    output: { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
    execute: async args => ({ forgotten: await memory.forget(roleId, args.id) }),
  }))
}
