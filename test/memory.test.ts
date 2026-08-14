import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { applyMemoryTools, ShioriMemoryService } from '../src/memory.ts'
import { WorkspaceMemoryTable } from '../src/file-memory-table.ts'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function table() {
  const values = new Map<string, any>()
  return {
    get: (key: string) => values.get(key),
    entries: () => values.entries(),
    keys: () => values.keys(),
    get size() { return values.size },
    put: async (key: string, value: any) => { values.set(key, value) },
    delete: async (key: string) => values.delete(key),
    update: async () => { throw new Error('not used') },
  } as any
}

test('keeps structured memories isolated by role and reinforces exact duplicates', async () => {
  const memory = new ShioriMemoryService(table())
  const first = await memory.mutate({
    kind: 'remember',
    scope: { roleId: 'role-a', sessionKey: 'session-a' },
    summary: 'Only role A knows this.',
    memoryKind: 'preference',
    memoryDomain: 'relationship',
    sourceRef: 'turn:1',
    evidence: [{ kind: 'turn', refs: ['turn:1'], sourceRef: 'chat' }],
  })

  assert.equal(first.status, 'new')
  assert.ok(first.item?.id.startsWith('role-a:'))
  assert.equal(first.item?.kind, 'preference')
  assert.equal(first.item?.domain, 'relationship')
  assert.equal(first.item?.sourceRef, 'turn:1')
  assert.deepEqual(first.item?.scope, { roleId: 'role-a', sessionKey: 'session-a' })
  assert.deepEqual(first.item?.evidence, [{ kind: 'turn', refs: ['turn:1'], sourceRef: 'chat' }])
  assert.equal(memory.query({ scope: { roleId: 'role-b' } }).records.length, 0)

  const reinforced = await memory.mutate({
    kind: 'remember',
    scope: { roleId: 'role-a' },
    summary: 'only role a knows this.',
    memoryKind: 'preference',
    memoryDomain: 'relationship',
  })
  assert.equal(reinforced.status, 'reinforced')
  assert.equal(reinforced.item?.id, first.item?.id)
  assert.equal(reinforced.item?.reinforcementCount, 1)

  const query = memory.query({ scope: { roleId: 'role-a' }, text: 'ROLE A' })
  assert.equal(query.records[0]?.summary, 'Only role A knows this.')
  assert.match(query.textBlock, new RegExp(`\\[${first.item?.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`))
})

test('reports affected and missing ids without allowing cross-role deletion', async () => {
  const memory = new ShioriMemoryService(table())
  const saved = await memory.memorize('role-a', 'A durable fact.')

  const denied = await memory.mutate({ kind: 'forget', scope: { roleId: 'role-b' }, ids: [saved.id] })
  assert.deepEqual(denied, {
    accepted: false,
    status: 'not_found',
    affectedIds: [],
    missingIds: [saved.id],
  })

  const forgotten = await memory.mutate({ kind: 'forget', scope: { roleId: 'role-a' }, ids: [saved.id, 'missing'] })
  assert.deepEqual(forgotten, {
    accepted: true,
    status: 'forgotten',
    affectedIds: [saved.id],
    missingIds: ['missing'],
  })
  assert.equal(memory.recall('role-a').length, 0)
})

test('stores Shiori memory_items metadata and removes rows by source reference', async () => {
  const memory = new ShioriMemoryService(table())
  const saved = await memory.mutate({
    kind: 'remember',
    scope: { roleId: 'role-a', channel: 'desktop', chatId: 'chat-1' },
    summary: 'A source-backed fact.',
    memoryKind: 'event',
    memoryDomain: 'shared',
    sourceRef: 'turn:42',
    extra: { topic: 'test' },
  })
  assert.equal(saved.item?.memoryType, 'event')
  assert.match(saved.item?.contentHash ?? '', /^[0-9a-f]{8}$/)
  assert.deepEqual(saved.item?.extra, {
    roleId: 'role-a',
    memoryDomain: 'shared',
    scopeChannel: 'desktop',
    scopeChatId: 'chat-1',
    topic: 'test',
  })
  assert.deepEqual(await memory.forgetBySourceRef('role-a', 'turn:42'), [saved.item?.id])
  assert.equal(memory.query({ scope: { roleId: 'role-a' } }).records.length, 0)
})

test('persists workspace memory below shiori-plugin/role/<role>/memory', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shiori-role-memory-'))
  try {
    const first = new ShioriMemoryService(new WorkspaceMemoryTable(workspace))
    const saved = await first.memorize('role-a', 'Survives a service restart.')
    const path = join(workspace, 'shiori-plugin', 'role', 'role-a', 'memory', 'memory.json')
    assert.match(await readFile(path, 'utf8'), /Survives a service restart/)
    const restarted = new ShioriMemoryService(new WorkspaceMemoryTable(workspace))
    assert.equal(restarted.recall('role-a')[0]?.id, saved.id)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('registers role memory tools and disposes them with the Agent scope', async () => {
  const memory = new ShioriMemoryService(table())
  await memory.memorize('role-a', 'Context-visible memory.')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const plugin = Object.assign(
    (inner: Context) => applyMemoryTools(inner, memory, { roleId: 'role-a', sessionKey: 'session-a' }),
    { inject: ['systemPrompt', 'tools'] },
  )
  const scope = await ctx.plugin(plugin)

  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), ['recall_memory', 'memorize', 'forget_memory'])
  assert.match(memory.context({ roleId: 'role-a' }), /Context-visible memory/)

  await scope.dispose()
  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), [])
})
