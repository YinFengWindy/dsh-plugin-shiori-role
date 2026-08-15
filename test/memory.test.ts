import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { applyMemoryTools, extractMemories, ShioriMemoryService } from '../src/memory.ts'
import { WorkspaceMemoryTable } from '../src/file-memory-table.ts'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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

const EMBEDDING_CONFIG = { endpoint: 'https://embedding.test/v1', model: 'test-embed' }
const EXTRACTION_CONFIG = { endpoint: 'https://chat.test/v1', model: 'test-chat' }

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** Replace global fetch for the duration of one test. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = ((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input)
    return handler(url, init)
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

/** Deterministic theme embedding: coffee-leaning by default, tea otherwise. */
function themeEmbedding(text: string): number[] {
  return text.toLocaleLowerCase().includes('tea') ? [0, 1, 0] : [1, 0, 0]
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

test('persists semantic memory without creating Markdown files', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shiori-role-memory-'))
  try {
    const first = new ShioriMemoryService(new WorkspaceMemoryTable(workspace))
    const saved = await first.memorize('role-a', 'Survives a service restart.')
    const memoryDir = join(workspace, 'shiori-plugin', 'role', 'role-a', 'memory')
    assert.match(await readFile(join(memoryDir, 'semantic.json'), 'utf8'), /Survives a service restart/)
    await first.memorize('role-a', 'Second semantic fact.')
    assert.deepEqual((await readdir(memoryDir)).filter(name => name.endsWith('.md')), [])
    const restarted = new ShioriMemoryService(new WorkspaceMemoryTable(workspace))
    assert.equal(restarted.recall('role-a').find(item => item.summary === saved.summary)?.id, saved.id)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('shares one role memory file across independent DSH workspace services', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-role-shared-memory-'))
  try {
    const first = new ShioriMemoryService(new WorkspaceMemoryTable(root))
    await first.memorize('role-a', 'Shared by workspace one and two.')
    const second = new ShioriMemoryService(new WorkspaceMemoryTable(root))
    assert.equal(second.recall('role-a')[0]?.summary, 'Shared by workspace one and two.')
    assert.match(second.context({ roleId: 'role-a' }), /Shared by workspace one and two/)
  } finally {
    await rm(root, { recursive: true, force: true })
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

test('recalls through independent vector and keyword lanes fused by RRF', async () => {
  const restore = stubFetch((url, init) => {
    if (!url.endsWith('/embeddings')) throw new Error(`unexpected url ${url}`)
    const input = String(requestBody(init).input ?? '')
    return jsonResponse({ data: [{ embedding: themeEmbedding(input) }] })
  })
  try {
    const memory = new ShioriMemoryService(table(), { embedding: EMBEDDING_CONFIG })
    // Older, keyword-hit row with a strong semantic match to the query theme.
    await memory.memorize('role-a', 'the user loves coffee')
    // Newer keyword-hit row whose theme differs from the query.
    await memory.memorize('role-a', 'the user prefers tea')
    // Semantic-only row: no keyword overlap with the query, still recalled.
    await memory.memorize('role-a', 'espresso machine')

    const result = await memory.queryAsync({ scope: { roleId: 'role-a' }, text: 'user' })
    assert.equal(result.trace.retrieval, 'hybrid-rrf')
    const summaries = result.records.map(record => record.summary)
    assert.ok(summaries.includes('the user loves coffee'), 'keyword+vector hit ranks in')
    assert.ok(summaries.includes('espresso machine'), 'vector lane independently recalls semantic rows')
    assert.ok(summaries.includes('the user prefers tea'), 'keyword lane keeps literal hits')
    assert.equal(result.records[0]?.summary, 'the user loves coffee')
  } finally {
    restore()
  }
})

test('persists embeddings into the semantic file layer', async () => {
  const restore = stubFetch((url, init) => {
    if (!url.endsWith('/embeddings')) throw new Error(`unexpected url ${url}`)
    return jsonResponse({ data: [{ embedding: [0.25, 0.5, 0.75] }] })
  })
  const workspace = await mkdtemp(join(tmpdir(), 'shiori-role-embedding-'))
  try {
    const memory = new ShioriMemoryService(new WorkspaceMemoryTable(workspace), { embedding: EMBEDDING_CONFIG })
    const saved = await memory.memorize('role-a', 'Embedded and durable.')
    assert.deepEqual(saved.embedding, [0.25, 0.5, 0.75])
    const semantic = JSON.parse(await readFile(
      join(workspace, 'shiori-plugin', 'role', 'role-a', 'memory', 'semantic.json'), 'utf8',
    )) as Array<{ record: { embedding?: number[] } }>
    assert.deepEqual(semantic[0]?.record?.embedding, [0.25, 0.5, 0.75])
    const restarted = new ShioriMemoryService(new WorkspaceMemoryTable(workspace), { embedding: EMBEDDING_CONFIG })
    assert.deepEqual(restarted.recall('role-a')[0]?.embedding, [0.25, 0.5, 0.75])
  } finally {
    restore()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('degrades to deterministic retrieval when the embedding endpoint fails', async () => {
  const restore = stubFetch(() => { throw new Error('embedding service down') })
  try {
    const memory = new ShioriMemoryService(table(), { embedding: EMBEDDING_CONFIG })
    const saved = await memory.memorize('role-a', 'Survives without an embedding.')
    assert.equal(saved.embedding, undefined)
    await memory.memorize('role-a', 'Second memory row.')
    const result = await memory.queryAsync({ scope: { roleId: 'role-a' }, text: 'second' })
    assert.equal(result.trace.retrieval, 'deterministic-text')
    assert.equal(result.records[0]?.summary, 'Second memory row.')
  } finally {
    restore()
  }
})

test('extracts Shiori-style profile, preference, and procedure memories', async () => {
  const restore = stubFetch((url, init) => {
    if (!url.endsWith('/chat/completions')) throw new Error(`unexpected url ${url}`)
    const body = requestBody(init)
    assert.equal(body.model, 'test-chat')
    assert.equal((body.messages as Array<{ role: string }>)[0]?.role, 'system')
    return jsonResponse({
      choices: [{ message: { content: `这里有些前导文字\n\`\`\`json\n${JSON.stringify({
        profile: [{ summary: '你住在上海', category: 'personal_fact', emotional_weight: 0 }],
        preference: [{ summary: '不喜欢悬疑风格的游戏', emotional_weight: 3 }],
        procedure: [{ summary: '查菜谱只推荐 20 分钟内的菜式', emotional_weight: 0 }],
      })}\n\`\`\`` } }],
    })
  })
  try {
    const items = await extractMemories(EXTRACTION_CONFIG, 'USER: 我住在上海，以后查菜谱只给我 20 分钟能做完的\nASSISTANT: 好的', '- [profile] 现有画像')
    assert.deepEqual(items, [
      { summary: '你住在上海', kind: 'profile', category: 'personal_fact', emotionalWeight: 0 },
      { summary: '不喜欢悬疑风格的游戏', kind: 'preference', emotionalWeight: 3 },
      { summary: '查菜谱只推荐 20 分钟内的菜式', kind: 'procedure', emotionalWeight: 0 },
    ])
  } finally {
    restore()
  }
})

test('extraction tolerates empty or malformed responses', async () => {
  const restore = stubFetch((url, init) => {
    if (!url.endsWith('/chat/completions')) throw new Error(`unexpected url ${url}`)
    const messages = requestBody(init).messages as Array<{ content: string }>
    const input = messages.map(message => message.content).join('\n')
    if (input.includes('empty')) return jsonResponse({ choices: [{ message: { content: '这里什么都没有' } }] })
    if (input.includes('array')) return jsonResponse({ choices: [{ message: { content: '[]' } }] })
    return jsonResponse({ choices: [{ message: { content: '{"profile": [{"summary": "只有一条"}]}' } }] })
  })
  try {
    assert.deepEqual(await extractMemories(EXTRACTION_CONFIG, 'empty'), [])
    assert.deepEqual(await extractMemories(EXTRACTION_CONFIG, 'array'), [])
    assert.deepEqual(await extractMemories(EXTRACTION_CONFIG, 'object'), [
      { summary: '只有一条', kind: 'profile' },
    ])
  } finally {
    restore()
  }
})

test('saveExtracted persists candidates with Shiori extra fields and reinforces duplicates', async () => {
  const memory = new ShioriMemoryService(table())
  const first = await memory.saveExtracted(
    { roleId: 'role-a', sessionKey: 'session-a' },
    'turn:1',
    [
      { summary: '你住在上海', kind: 'profile', category: 'personal_fact', happenedAt: '2026-08-14T00:00:00Z', emotionalWeight: 7 },
      { summary: '查菜谱只推荐 20 分钟内的菜式', kind: 'procedure', toolRequirement: 'web_search', steps: ['搜菜谱', '过滤时长'] },
      { summary: '', kind: 'profile' },
    ],
    [{ kind: 'turn', refs: ['turn:1'], sourceRef: 'session-a' }],
  )
  assert.equal(first.length, 2)
  const profile = memory.recall('role-a').find(item => item.kind === 'profile')
  assert.ok(profile)
  assert.equal(profile.sourceRef, 'turn:1')
  assert.equal(profile.happenedAt, '2026-08-14T00:00:00Z')
  assert.equal(profile.extra.emotional_weight, '7')
  assert.equal(profile.extra.category, 'personal_fact')
  assert.deepEqual(profile.evidence, [{ kind: 'turn', refs: ['turn:1'], sourceRef: 'session-a' }])

  const procedure = memory.recall('role-a').find(item => item.kind === 'procedure')
  assert.equal(procedure?.extra.tool_requirement, 'web_search')
  assert.deepEqual(JSON.parse(procedure?.extra.steps ?? '[]'), ['搜菜谱', '过滤时长'])

  const reinforced = await memory.saveExtracted(
    { roleId: 'role-a', sessionKey: 'session-a' },
    'turn:2',
    [{ summary: '你住在上海', kind: 'profile' }],
  )
  assert.equal(reinforced[0]?.status, 'reinforced')
  assert.equal(reinforced[0]?.item?.id, profile.id)
  assert.equal(reinforced[0]?.item?.reinforcementCount, 1)
})
