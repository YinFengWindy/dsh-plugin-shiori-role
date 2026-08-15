import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DefaultMemoryEngine } from '../src/memory-engine/engine.ts'
import { Embedder, ChatClient } from '../src/memory-engine/llm.ts'
import { ShioriMemoryStore, resolveMemoryDbPath } from '../src/memory-engine/store.ts'
import { resolveMemoryConfig } from '../src/memory-engine/config.ts'

const EMBEDDING_ENDPOINT = { endpoint: 'https://embedding.test/v1', apiKey: 'k', model: 'test-embed' }

test('resolves SQLite storage exclusively inside the role directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-role-path-'))
  try {
    assert.equal(
      resolveMemoryDbPath(root, 'yin-feng'),
      join(root, 'shiori-plugin', 'role', 'yin-feng', 'memory', 'memory2.db'),
    )
    assert.throws(() => resolveMemoryDbPath(root, '../shared'), /invalid role id/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

function stubEmbeddings(embed: (text: string) => number[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = ((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input)
    if (!url.endsWith('/embeddings')) throw new Error(`unexpected url ${url}`)
    const body = JSON.parse(String(init?.body)) as { input: string[] }
    return Promise.resolve(jsonResponse({ data: body.input.map((text, index) => ({ index, embedding: embed(text) })) }))
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/** coffee 主题向量；'tea' 字样 → 茶主题。 */
function themeEmbedding(text: string): number[] {
  return text.toLowerCase().includes('tea') ? [0, 1, 0] : [1, 0, 0]
}

async function engineWith(options: { root: string; embedding?: boolean }): Promise<{ engine: DefaultMemoryEngine; close(): void }> {
  const store = new ShioriMemoryStore(join(options.root, 'memory2.db'))
  const engine = new DefaultMemoryEngine({
    store,
    ...(options.embedding === true
      ? { embedder: new Embedder(EMBEDDING_ENDPOINT) }
      : {}),
    config: { retrieval: resolveMemoryConfig() },
  })
  return { engine, close: () => store.close() }
}

test('reinforces exact duplicates and supersedes semantically similar memories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-engine-supersede-'))
  const restore = stubEmbeddings(themeEmbedding)
  let closeStore: (() => void) | undefined
  try {
    const { engine, close } = await engineWith({ root, embedding: true })
    closeStore = close
    const first = await engine.mutate({
      kind: 'remember', scope: { roleId: 'role-a' },
      summary: 'the user loves coffee', memoryKind: 'preference', memoryDomain: 'relationship',
    })
    assert.equal(first.status, 'new')

    // 相同 content-hash → reinforced
    const duplicate = await engine.mutate({
      kind: 'remember', scope: { roleId: 'role-a' },
      summary: 'the user loves coffee', memoryKind: 'preference',
    })
    assert.equal(duplicate.status, 'reinforced')

    // 语义高度相似（cosine 1.0 ≥ 0.9）→ 旧条目退休
    const similar = await engine.mutate({
      kind: 'remember', scope: { roleId: 'role-a' },
      summary: 'the user adores coffee', memoryKind: 'preference',
    })
    assert.equal(similar.status, 'new')
    assert.notEqual(similar.itemId, first.itemId)
    const admin = engine.getItemForAdmin(first.itemId!)
    assert.equal(admin?.status, 'superseded')
    const active = await engine.recall('role-a')
    assert.ok(active.every(item => item.id !== first.itemId), 'superseded memory is not recalled')
  } finally {
    closeStore?.()
    restore()
    await rm(root, { recursive: true, force: true })
  }
})

test('merges procedures sharing a tool requirement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-engine-merge-'))
  const restore = stubEmbeddings(themeEmbedding)
  let closeStore: (() => void) | undefined
  try {
    const { engine, close } = await engineWith({ root, embedding: true })
    closeStore = close
    const first = await engine.mutate({
      kind: 'remember', scope: { roleId: 'role-a' },
      summary: '搜索前先查缓存', memoryKind: 'procedure',
      metadata: { tool_requirement: 'web_search' },
    })
    const second = await engine.mutate({
      kind: 'remember', scope: { roleId: 'role-a' },
      summary: '搜索前先查缓存再更新索引', memoryKind: 'procedure',
      metadata: { tool_requirement: 'web_search' },
    })
    // 同工具 + 高相似 → 合并进第一条，不新建
    assert.equal(second.itemId, first.itemId)
    const merged = engine.getItemForAdmin(first.itemId!)
    assert.match(String(merged?.summary), /缓存/)
    assert.match(String(merged?.summary), /更新索引/)
  } finally {
    closeStore?.()
    restore()
    await rm(root, { recursive: true, force: true })
  }
})

test('recalls via independent vector and keyword lanes fused by RRF', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-engine-rrf-'))
  const restore = stubEmbeddings(themeEmbedding)
  let closeStore: (() => void) | undefined
  try {
    const { engine, close } = await engineWith({ root, embedding: true })
    closeStore = close
    await engine.mutate({ kind: 'remember', scope: { roleId: 'role-a' }, summary: 'the user loves coffee', memoryKind: 'preference' })
    await engine.mutate({ kind: 'remember', scope: { roleId: 'role-a' }, summary: 'the user prefers tea', memoryKind: 'preference' })
    // 语义相关但无关键词重叠的条目：query 'coffee' 不包含它，但向量 lane 能召回
    await engine.mutate({ kind: 'remember', scope: { roleId: 'role-a' }, summary: 'espresso machine', memoryKind: 'profile' })

    const result = await engine.query({ text: 'coffee', intent: 'answer', scope: { roleId: 'role-a' }, limit: 8 })
    const summaries = result.records.map(record => record.summary)
    assert.ok(summaries.includes('the user loves coffee'))
    assert.ok(summaries.includes('espresso machine'), 'vector lane independently recalls semantic rows')
    assert.ok(!summaries.includes('the user prefers tea'), 'irrelevant rows stay out')
  } finally {
    closeStore?.()
    restore()
    await rm(root, { recursive: true, force: true })
  }
})

test('persists memories across store restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-engine-persist-'))
  try {
    const firstHandle = await engineWith({ root })
    await firstHandle.engine.mutate({ kind: 'remember', scope: { roleId: 'role-a' }, summary: 'Survives restart', memoryKind: 'profile' })
    const saved = (await firstHandle.engine.recall('role-a'))[0]
    assert.ok(saved)
    firstHandle.close()

    const restartedHandle = await engineWith({ root })
    const records = await restartedHandle.engine.recall('role-a')
    assert.equal(records[0]?.summary, 'Survives restart')
    assert.equal(records[0]?.id, saved?.id)
    restartedHandle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('forgets by id without cross-role deletion and invalidates role memories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-engine-forget-'))
  let closeStore: (() => void) | undefined
  try {
    const { engine, close } = await engineWith({ root })
    closeStore = close
    const saved = await engine.mutate({ kind: 'remember', scope: { roleId: 'role-a' }, summary: 'A durable fact' })
    const denied = await engine.mutate({ kind: 'forget', scope: { roleId: 'role-b' }, ids: [saved.itemId!] })
    assert.equal(denied.accepted, false)

    const forgotten = await engine.mutate({ kind: 'forget', scope: { roleId: 'role-a' }, ids: [saved.itemId!] })
    assert.equal(forgotten.accepted, true)
    assert.equal(engine.getItemForAdmin(saved.itemId!)?.status, 'superseded')

    const second = await engine.mutate({ kind: 'remember', scope: { roleId: 'role-a' }, summary: 'Another fact' })
    const invalidated = engine.invalidateRoleMemories('role-a')
    assert.equal(invalidated, 1)
    assert.equal(engine.getItemForAdmin(second.itemId!)?.status, 'superseded')
  } finally {
    closeStore?.()
    await rm(root, { recursive: true, force: true })
  }
})

test('degrades gracefully when embedding endpoint fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-engine-degrade-'))
  const restore = stubEmbeddings(() => { throw new Error('embedding down') })
  let closeStore: (() => void) | undefined
  try {
    const { engine, close } = await engineWith({ root, embedding: true })
    closeStore = close
    const saved = await engine.mutate({ kind: 'remember', scope: { roleId: 'role-a' }, summary: 'Still saved without embedding' })
    assert.equal(saved.accepted, true)
    const result = await engine.query({ text: 'embedding', intent: 'answer', scope: { roleId: 'role-a' }, limit: 8 })
    assert.ok(result.records.some(record => record.summary.includes('Still saved')))
  } finally {
    closeStore?.()
    restore()
    await rm(root, { recursive: true, force: true })
  }
})

test('extracts memories through the chat endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-engine-extract-'))
  const original = globalThis.fetch
  globalThis.fetch = ((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input)
    if (!url.endsWith('/chat/completions')) throw new Error(`unexpected url ${url}`)
    return Promise.resolve(jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        profile: [{ summary: '你住在上海', category: 'personal_fact', emotional_weight: 2 }],
        preference: [{ summary: '不喜欢悬疑风格的游戏', emotional_weight: 5 }],
        procedure: [],
      }) } }],
    }))
  }) as typeof fetch
  let store: ShioriMemoryStore | undefined
  try {
    store = new ShioriMemoryStore(join(root, 'memory2.db'))
    const engine = new DefaultMemoryEngine({
      store,
      chat: new ChatClient({ endpoint: 'https://chat.test/v1', model: 'test-chat' }),
      config: { retrieval: resolveMemoryConfig() },
    })
    const result = await engine.ingest({
      content: 'USER: 我住在上海，不喜欢悬疑游戏\nASSISTANT: 记住了',
      sourceKind: 'conversation_turn',
      scope: { roleId: 'role-a', sessionKey: 'session-1' },
      metadata: { source_ref: 'turn:1' },
    })
    assert.equal(result.accepted, true)
    const records = await engine.recall('role-a')
    const profile = records.find(item => item.kind === 'profile')
    assert.equal(profile?.summary, '你住在上海')
    assert.equal((profile?.signals as Record<string, unknown>).category, 'personal_fact')
    assert.equal((profile?.signals as Record<string, unknown>).emotional_weight, 2)
    assert.equal(profile?.evidence?.[0]?.sourceRef, 'turn:1#profile')
    const preference = records.find(item => item.kind === 'preference')
    assert.equal(preference?.summary, '不喜欢悬疑风格的游戏')
  } finally {
    store?.close()
    globalThis.fetch = original
    await rm(root, { recursive: true, force: true })
  }
})
