import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createScope, scopeOf, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ShioriRoleService } from '../src/service.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

function stubFetchChat(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = ((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input)
    return handler(url, init)
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor: condition not met before timeout')
}

function memoryDomain() {
  const tables = new Map<string, Map<string, unknown>>()
  return { tables, service: {
    async open() {
      return {
        table(name: string) {
          const values = tables.get(name) ?? new Map<string, unknown>()
          tables.set(name, values)
          return {
            get: (key: string) => values.get(key),
            put: async (key: string, value: unknown) => { values.set(key, value) },
            delete: async (key: string) => values.delete(key),
            update: async () => { throw new Error('not used') },
            entries: () => values.entries(),
            keys: () => values.keys(),
            get size() { return values.size },
          }
        },
        global: undefined,
        async close() {},
      }
    },
  } }
}

function attachmentService() {
  const bytes = new Map<string, Uint8Array>()
  return {
    bytes,
    service: {
      imageLimits: { maxImageBytes: 10_000, maxImagesPerMessage: 10, maxMessageImageBytes: 20_000, maxImagePixels: 1_000_000, mediaTypes: ['image/png'] },
      async validateImage() {},
      async saveImage(input: { data: Uint8Array; mediaType: 'image/png'; name?: string }) {
        const attachmentId = `asset-${bytes.size + 1}`
        bytes.set(attachmentId, input.data)
        return { attachmentId, mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1, ...(input.name === undefined ? {} : { name: input.name }) }
      },
      async readImage(ref: { attachmentId: string }) {
        return { ref, data: bytes.get(ref.attachmentId) ?? new Uint8Array() }
      },
    },
  }
}

test('persists a workspace default and binds it once to a new Agent scope', async () => {
  const ctx = new Context()
  const domain = memoryDomain()
  const attachments = attachmentService()
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('attachments', attachments.service as never)
  ctx.provide('workspaceRegistry', {
    resolveByPath: async () => ({ id: 'workspace-a' }),
  } as never)
  await ctx.plugin(SystemPrompt, { persona: 'Deployment identity.' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ShioriRoleService, {
    roles: [{ id: 'maintainer', name: 'Maintainer', prompt: 'You are the Shiori maintainer.' }],
  })
  await ctx.shioriRole.select('workspace-a' as never, 'maintainer')

  const agent = {
    id: 'session-1',
    session: { id: 'session-1', header: { cwd: 'C:/workspace' } },
  }
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, agent)
  }, { inject: ['systemPrompt', 'shioriRole'] }))

  await ctx.shioriRole.compose(scope.ctx)
  const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeOf(scope.ctx)! }))
  assert.match(prompt, /Shiori maintainer/)
  assert.equal((await ctx.shioriRole.active('workspace-a' as never))?.id, 'maintainer')

  await scope.dispose()
})

async function agent(ctx: Context, rawId: string, cwd: string): Promise<{ agent: Agent, scope: Scope }> {
  const id = SessionId(rawId)
  const session = Session.create(id, undefined, { version: 0, id, createdAt: Date.now(), cwd })
  const value = {
    id,
    session,
    options: {},
  } as unknown as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, value)
  }, { inject: ['systemPrompt', 'tools'] }))
  ;(value as { ctx: Context }).ctx = scope.ctx
  return { agent: value, scope }
}

test('automatically mounts workspace roles and preserves a resumed session binding', async () => {
  const ctx = new Context()
  const domain = memoryDomain()
  const attachments = attachmentService()
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('attachments', attachments.service as never)
  ctx.provide('workspaceRegistry', {
    list: () => [{ id: 'workspace-a', path: 'C:\\workspace' }],
    resolveByPath: async () => ({ id: 'workspace-a' }),
  } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ShioriRoleService, {
    roles: [
      { id: 'maintainer', name: 'Maintainer', prompt: 'You are the Shiori maintainer.' },
      { id: 'writer', name: 'Writer', prompt: 'You are the Shiori writer.' },
    ],
  })
  await ctx.shioriRole.select('workspace-a' as never, 'maintainer')

  const first = await agent(ctx, 'session-automatic', 'C:\\workspace')
  const disposeFirst = ctx.agents.register(first.agent)
  const firstPrompt = renderPrompt(await ctx.systemPrompt.assemble({ agent: first.agent, scope: first.agent }))
  assert.match(firstPrompt, /Shiori maintainer/)
  assert.deepEqual(ctx.tools.schemas(first.agent).map(tool => tool.name), ['recall_memory', 'memorize', 'forget_memory'])
  assert.equal((domain.tables.get('session_roles')?.get('session-automatic') as { roleId?: string })?.roleId, 'maintainer')

  await ctx.shioriRole.select('workspace-a' as never, 'writer')
  const second = await agent(ctx, 'session-new', 'C:\\workspace')
  const disposeSecond = ctx.agents.register(second.agent)
  const secondPrompt = renderPrompt(await ctx.systemPrompt.assemble({ agent: second.agent, scope: second.agent }))
  assert.match(secondPrompt, /Shiori writer/)

  disposeFirst()
  await first.scope.dispose()
  const resumed = await agent(ctx, 'session-automatic', 'C:\\workspace')
  const disposeResumed = ctx.agents.register(resumed.agent)
  const resumedPrompt = renderPrompt(await ctx.systemPrompt.assemble({ agent: resumed.agent, scope: resumed.agent }))
  assert.match(resumedPrompt, /Shiori maintainer/)
  assert.doesNotMatch(resumedPrompt, /Shiori writer/)

  disposeResumed()
  disposeSecond()
  await resumed.scope.dispose()
  await second.scope.dispose()
})

test('exposes a client-safe snapshot and updates the workspace default remotely', async () => {
  const ctx = new Context()
  const domain = memoryDomain()
  const attachments = attachmentService()
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('attachments', attachments.service as never)
  ctx.provide('workspaceRegistry', { resolveByPath: async () => undefined } as never)
  await ctx.plugin(ShioriRoleService, {
    roles: [{ id: 'maintainer', name: 'Maintainer', prompt: 'Private model prompt.' }],
  })

  const initial = await ctx.shioriRole.snapshot('workspace-a')
  assert.equal(initial.workspaceId, 'workspace-a')
  assert.equal(initial.roles[0]?.name, 'Maintainer')
  assert.equal(initial.roles[0]?.prompt, 'Private model prompt.')
  const selected = await ctx.shioriRole.selectRemote('workspace-a', 'maintainer')
  assert.equal(selected.activeRoleId, 'maintainer')
})

test('stages a blank-session role and commits it on first prompt assembly', async () => {
  const ctx = new Context()
  const domain = memoryDomain()
  const attachments = attachmentService()
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('attachments', attachments.service as never)
  ctx.provide('workspaceRegistry', { list: () => [], resolveByPath: async () => undefined } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ShioriRoleService, {
    roles: [
      { id: 'maintainer', name: 'Maintainer', prompt: 'Maintainer prompt.' },
      { id: 'writer', name: 'Writer', prompt: 'Writer prompt.' },
    ],
  })

  const created = await agent(ctx, 'session-pending', 'C:\\workspace')
  const dispose = ctx.agents.register(created.agent)
  assert.equal((await ctx.shioriRole.sessionSnapshot('session-pending')).locked, false)
  const staged = await ctx.shioriRole.stageSessionRole('session-pending', 'writer')
  assert.equal(staged.pendingRoleId, 'writer')
  assert.equal(staged.locked, false)
  const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent: created.agent, scope: created.agent }))

  assert.match(prompt, /Writer prompt/)
  assert.equal((domain.tables.get('session_roles')?.get('session-pending') as { roleId?: string })?.roleId, 'writer')
  assert.equal(domain.tables.get('pending_session_roles')?.has('session-pending'), false)
  assert.equal((await ctx.shioriRole.sessionSnapshot('session-pending')).locked, true)
  await assert.rejects(ctx.shioriRole.stageSessionRole('session-pending', 'maintainer'), /already bound/)
  dispose()
  await created.scope.dispose()
})

test('migrates a legacy premature binding while its live session is still blank', async () => {
  const ctx = new Context()
  const domain = memoryDomain()
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('attachments', attachmentService().service as never)
  ctx.provide('workspaceRegistry', { list: () => [], resolveByPath: async () => undefined } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ShioriRoleService, {
    roles: [
      { id: 'maintainer', name: 'Maintainer', prompt: 'Maintainer prompt.' },
      { id: 'writer', name: 'Writer', prompt: 'Writer prompt.' },
    ],
  })
  domain.tables.get('session_roles')?.set('legacy-blank', {
    roleId: 'maintainer', boundAt: '2026-08-14T00:00:00.000Z', bindingVersion: 1,
  })
  const created = await agent(ctx, 'legacy-blank', 'C:\\workspace')
  const dispose = ctx.agents.register(created.agent)

  assert.equal((await ctx.shioriRole.sessionSnapshot('legacy-blank')).locked, false)
  const staged = await ctx.shioriRole.stageSessionRole('legacy-blank', 'writer')
  assert.equal(staged.pendingRoleId, 'writer')
  assert.equal(domain.tables.get('session_roles')?.has('legacy-blank'), false)
  dispose()
  await created.scope.dispose()
})

test('stores only attachment references in role assets and reads bytes through attachments', async () => {
  const ctx = new Context()
  const domain = memoryDomain()
  const attachments = attachmentService()
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('attachments', attachments.service as never)
  ctx.provide('workspaceRegistry', { resolveByPath: async () => undefined } as never)
  await ctx.plugin(ShioriRoleService, {
    roles: [{ id: 'maintainer', name: 'Maintainer', prompt: 'Prompt.' }],
  })

  const catalog = await ctx.shioriRole.uploadAsset({
    roleId: 'maintainer', purpose: 'avatar', mediaType: 'image/png', data: 'AQID', name: 'avatar.png',
  })
  const asset = catalog.roles[0]?.assets[0]
  assert.ok(asset)
  const stored = domain.tables.get('role_assets')?.get(asset.id) as { attachment?: { attachmentId?: string }; data?: string }
  assert.equal(stored.attachment?.attachmentId, 'asset-1')
  assert.equal(stored.data, undefined)
  assert.equal((await ctx.shioriRole.assetData(asset.id)).data, 'AQID')
})

test('imports configured roles only once so deleted seeds do not reappear', async () => {
  const domain = memoryDomain()
  const start = async () => {
    const ctx = new Context()
    ctx.provide('storageDomain', domain.service as never)
    ctx.provide('attachments', attachmentService().service as never)
    ctx.provide('workspaceRegistry', { resolveByPath: async () => undefined } as never)
    await ctx.plugin(ShioriRoleService, { roles: [{ id: 'seed', name: 'Seed', prompt: 'Seed prompt.' }] })
    return ctx
  }
  const first = await start()
  await first.shioriRole.deleteRole('seed')
  const second = await start()
  assert.deepEqual((await second.shioriRole.catalogSnapshot()).roles, [])
})

test('reassigns mutable references when their role is deleted', async () => {
  const ctx = new Context()
  const domain = memoryDomain()
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('attachments', attachmentService().service as never)
  ctx.provide('workspaceRegistry', { resolveByPath: async () => undefined } as never)
  await ctx.plugin(ShioriRoleService, {
    roles: [
      { id: 'maintainer', name: 'Maintainer', prompt: 'Maintainer prompt.' },
      { id: 'temporary', name: 'Temporary', prompt: 'Temporary prompt.' },
    ],
  })
  domain.tables.get('pending_session_roles')?.set('blank-session', {
    roleId: 'temporary', updatedAt: '2026-08-14T00:00:00.000Z',
  })
  domain.tables.get('workspace_roles')?.set('workspace-a', {
    roleId: 'temporary', updatedAt: '2026-08-14T00:00:00.000Z',
  })

  await ctx.shioriRole.deleteRole('temporary')

  assert.equal((domain.tables.get('pending_session_roles')?.get('blank-session') as { roleId?: string })?.roleId, 'maintainer')
  assert.equal((domain.tables.get('workspace_roles')?.get('workspace-a') as { roleId?: string })?.roleId, 'maintainer')
  assert.equal((await ctx.shioriRole.sessionSnapshot('blank-session')).pendingRoleId, 'maintainer')
})

test('soft-deletes roles retained by immutable sessions', async () => {
  const ctx = new Context()
  const domain = memoryDomain()
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('attachments', attachmentService().service as never)
  ctx.provide('workspaceRegistry', { resolveByPath: async () => undefined } as never)
  await ctx.plugin(ShioriRoleService, {
    roles: [
      { id: 'maintainer', name: 'Maintainer', prompt: 'Maintainer prompt.' },
      { id: 'writer', name: 'Writer', prompt: 'Writer prompt.' },
    ],
  })
  domain.tables.get('session_roles')?.set('bound-session', {
    roleId: 'maintainer', boundAt: '2026-08-14T00:00:00.000Z', bindingVersion: 2,
  })

  await ctx.shioriRole.deleteRole('maintainer')

  assert.deepEqual((await ctx.shioriRole.catalogSnapshot()).roles.map(role => role.id), ['writer'])
  const session = await ctx.shioriRole.sessionSnapshot('bound-session')
  assert.equal(session.roleId, 'maintainer')
  assert.equal(session.roles.find(role => role.id === 'maintainer')?.name, 'Maintainer')
})

test('extracts durable memories after a completed turn when extraction is configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-role-extraction-'))
  const restore = stubFetchChat((url, init) => {
    if (!url.endsWith('/chat/completions')) throw new Error(`unexpected url ${url}`)
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content: string }> }
    assert.match(body.messages?.[0]?.content ?? '', /长期记忆提取器/)
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        profile: [{ summary: '用户喜欢咖啡', category: 'personal_fact', emotional_weight: 4 }],
        preference: [],
        procedure: [],
      }) } }],
    })
  })
  try {
    const ctx = new Context()
    const domain = memoryDomain()
    ctx.provide('storageDomain', domain.service as never)
    ctx.provide('attachments', attachmentService().service as never)
    ctx.provide('workspaceRegistry', {
      list: () => [{ id: 'workspace-a', path: 'C:\\workspace' }],
      resolveByPath: async () => ({ id: 'workspace-a' }),
    } as never)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ShioriRoleService, {
      roles: [{ id: 'maintainer', name: 'Maintainer', prompt: 'Maintainer prompt.' }],
      memoryRoot: root,
      memory: { extraction: { endpoint: 'https://chat.test/v1', model: 'test-chat' } },
    })
    await ctx.shioriRole.select('workspace-a' as never, 'maintainer')

    const created = await agent(ctx, 'session-extract', 'C:\\workspace')
    const dispose = ctx.agents.register(created.agent)
    // Commit the role binding exactly like the first prompt assembly does.
    renderPrompt(await ctx.systemPrompt.assemble({ agent: created.agent, scope: created.agent }))

    const session = created.agent.session as Session
    session.append('turn/start', { turn: 1 })
    session.append('user/message', {
      id: 'u1', role: 'user', content: [{ type: 'text', text: '我喜欢喝咖啡' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '好的，记住了。' }], source: { kind: 'model', provider: 'test', model: 'test' } },
    }, { surfaceOp: 'append' })

    emitAgentEvent(ctx, created.agent, 'agent/turn-stopping', { turn: 1, signal: new AbortController().signal })

    await waitFor(() => ctx.shioriRole.memory().recall('maintainer').some(item => item.summary.includes('咖啡')))
    const item = ctx.shioriRole.memory().recall('maintainer').find(entry => entry.summary.includes('咖啡'))
    assert.equal(item?.kind, 'profile')
    assert.equal(item?.sourceRef, 'turn:1')
    assert.equal(item?.extra.category, 'personal_fact')
    assert.equal(item?.extra.emotional_weight, '4')
    assert.deepEqual(item?.evidence, [{ kind: 'turn', refs: ['turn:1'], sourceRef: 'session-extract' }])

    dispose()
    await created.scope.dispose()
  } finally {
    restore()
    await rm(root, { recursive: true, force: true })
  }
})
