import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createScope, scopeOf, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ShioriRoleService, type Config as RoleServiceConfig } from '../src/service.ts'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor: condition not met before timeout')
}

async function isolatedMemoryRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'shiori-role-service-'))
  return root
}

async function pluginService(ctx: Context, t: TestContext, config: RoleServiceConfig): Promise<void> {
  const fiber = await ctx.plugin(ShioriRoleService, config)
  t.after(async () => {
    await fiber.dispose()
    if (config.memoryRoot !== undefined) await rm(config.memoryRoot, { recursive: true, force: true })
  })
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

test('persists a workspace default and binds it once to a new Agent scope', async t => {
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
  await pluginService(ctx, t, {
    memoryRoot: await isolatedMemoryRoot(t),
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

async function agent(ctx: Context, rawId: string, cwd: string, parentSession?: string): Promise<{ agent: Agent, scope: Scope }> {
  const id = SessionId(rawId)
  const session = Session.create(id, undefined, {
    version: 0,
    id,
    createdAt: Date.now(),
    cwd,
    ...(parentSession === undefined ? {} : { parentSession: SessionId(parentSession) }),
  })
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

test('automatically mounts workspace roles and preserves a resumed session binding', async t => {
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
  await pluginService(ctx, t, {
    memoryRoot: await isolatedMemoryRoot(t),
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

test('leaves a blank workspace session selectable until its first prompt', async t => {
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
  await pluginService(ctx, t, {
    memoryRoot: await isolatedMemoryRoot(t),
    roles: [
      { id: 'maintainer', name: 'Maintainer', prompt: 'Maintainer prompt.' },
      { id: 'writer', name: 'Writer', prompt: 'Writer prompt.' },
    ],
  })
  await ctx.shioriRole.select('workspace-a' as never, 'maintainer')

  const created = await agent(ctx, 'session-bound-at-create', 'C:\\workspace')
  const dispose = ctx.agents.register(created.agent)
  assert.equal((await ctx.shioriRole.sessionSnapshot('session-bound-at-create')).locked, false)
  const staged = await ctx.shioriRole.stageSessionRole('session-bound-at-create', 'writer')
  assert.equal(staged.pendingRoleId, 'writer')
  assert.equal(staged.locked, false)
  const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent: created.agent, scope: created.agent }))
  assert.match(prompt, /Writer prompt/)
  assert.equal((domain.tables.get('session_roles')?.get('session-bound-at-create') as { roleId?: string })?.roleId, 'writer')

  dispose()
  await created.scope.dispose()
})

test('opens a workspace with no default role before the blank session selects one', async t => {
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
  await pluginService(ctx, t, {
    memoryRoot: await isolatedMemoryRoot(t),
    roles: [
      { id: 'maintainer', name: 'Maintainer', prompt: 'Maintainer prompt.' },
      { id: 'writer', name: 'Writer', prompt: 'Writer prompt.' },
    ],
  })

  const created = await agent(ctx, 'session-unselected-workspace', 'C:\\workspace')
  const dispose = ctx.agents.register(created.agent)
  const blank = await ctx.shioriRole.sessionSnapshot('session-unselected-workspace')
  assert.equal(blank.locked, false)
  assert.equal(blank.roleId, undefined)
  assert.equal(blank.roles.length, 2)
  assert.deepEqual(ctx.tools.schemas(created.agent).map(tool => tool.name), [])

  await ctx.shioriRole.stageSessionRole('session-unselected-workspace', 'writer')
  assert.deepEqual(ctx.tools.schemas(created.agent).map(tool => tool.name), ['recall_memory', 'memorize', 'forget_memory'])
  const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent: created.agent, scope: created.agent }))
  assert.match(prompt, /Writer prompt/)
  dispose()
  await created.scope.dispose()
})

test('bypasses role prompt and memory tools when a session uses no role', async t => {
  const ctx = new Context()
  const domain = memoryDomain()
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('attachments', attachmentService().service as never)
  ctx.provide('workspaceRegistry', {
    list: () => [{ id: 'workspace-a', path: 'C:\\workspace' }],
    resolveByPath: async () => ({ id: 'workspace-a' }),
  } as never)
  await ctx.plugin(SystemPrompt, { persona: 'Host persona.' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await pluginService(ctx, t, {
    memoryRoot: await isolatedMemoryRoot(t),
    roles: [{ id: 'optional-role', name: 'Optional', prompt: 'Optional role prompt.' }],
  })

  const created = await agent(ctx, 'session-without-role', 'C:\\workspace')
  const dispose = ctx.agents.register(created.agent)
  const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent: created.agent, scope: created.agent }))

  assert.match(prompt, /Host persona/)
  assert.doesNotMatch(prompt, /Optional role prompt/)
  assert.deepEqual(ctx.tools.schemas(created.agent).map(tool => tool.name), [])
  assert.equal(domain.tables.get('session_roles')?.has('session-without-role'), false)
  dispose()
  await created.scope.dispose()
})

test('inherits the parent role when a child Agent is created', async t => {
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
  await pluginService(ctx, t, {
    memoryRoot: await isolatedMemoryRoot(t),
    roles: [
      { id: 'maintainer', name: 'Maintainer', prompt: 'Maintainer prompt.' },
      { id: 'writer', name: 'Writer', prompt: 'Writer prompt.' },
    ],
  })
  await ctx.shioriRole.select('workspace-a' as never, 'maintainer')

  const parent = await agent(ctx, 'session-parent', 'C:\\workspace')
  const disposeParent = ctx.agents.register(parent.agent)
  await ctx.shioriRole.select('workspace-a' as never, 'writer')
  const child = await agent(ctx, 'session-child', 'C:\\workspace', 'session-parent')
  const disposeChild = ctx.agents.register(child.agent)

  assert.equal((domain.tables.get('session_roles')?.get('session-child') as { roleId?: string })?.roleId, undefined)
  const childPrompt = renderPrompt(await ctx.systemPrompt.assemble({ agent: child.agent, scope: child.agent }))
  assert.match(childPrompt, /Maintainer prompt/)
  assert.equal((domain.tables.get('session_roles')?.get('session-child') as { roleId?: string })?.roleId, 'maintainer')

  disposeChild()
  disposeParent()
  await child.scope.dispose()
  await parent.scope.dispose()
})

test('exposes a client-safe snapshot and updates the workspace default remotely', async t => {
  const ctx = new Context()
  const domain = memoryDomain()
  const attachments = attachmentService()
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('attachments', attachments.service as never)
  ctx.provide('workspaceRegistry', { resolveByPath: async () => undefined } as never)
  await pluginService(ctx, t, {
    memoryRoot: await isolatedMemoryRoot(t),
    roles: [{ id: 'maintainer', name: 'Maintainer', prompt: 'Private model prompt.' }],
  })

  const initial = await ctx.shioriRole.snapshot('workspace-a')
  assert.equal(initial.workspaceId, 'workspace-a')
  assert.equal(initial.roles[0]?.name, 'Maintainer')
  assert.equal(initial.roles[0]?.prompt, 'Private model prompt.')
  const selected = await ctx.shioriRole.selectRemote('workspace-a', 'maintainer')
  assert.equal(selected.activeRoleId, 'maintainer')
})

test('stages a role before Agent creation and commits it at publication', async t => {
  const ctx = new Context()
  const domain = memoryDomain()
  const attachments = attachmentService()
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('attachments', attachments.service as never)
  ctx.provide('workspaceRegistry', { list: () => [], resolveByPath: async () => undefined } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await pluginService(ctx, t, {
    memoryRoot: await isolatedMemoryRoot(t),
    roles: [
      { id: 'maintainer', name: 'Maintainer', prompt: 'Maintainer prompt.' },
      { id: 'writer', name: 'Writer', prompt: 'Writer prompt.' },
    ],
  })

  const staged = await ctx.shioriRole.stageSessionRole('session-pending', 'writer')
  assert.equal(staged.pendingRoleId, 'writer')
  assert.equal(staged.locked, false)
  const created = await agent(ctx, 'session-pending', 'C:\\workspace')
  const dispose = ctx.agents.register(created.agent)
  const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent: created.agent, scope: created.agent }))

  assert.match(prompt, /Writer prompt/)
  assert.equal((domain.tables.get('session_roles')?.get('session-pending') as { roleId?: string })?.roleId, 'writer')
  assert.equal(domain.tables.get('pending_session_roles')?.has('session-pending'), false)
  assert.equal((await ctx.shioriRole.sessionSnapshot('session-pending')).locked, true)
  await assert.rejects(ctx.shioriRole.stageSessionRole('session-pending', 'maintainer'), /already bound/)
  dispose()
  await created.scope.dispose()
})

test('preserves a legacy session binding even when its log is still blank', async t => {
  const ctx = new Context()
  const domain = memoryDomain()
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('attachments', attachmentService().service as never)
  ctx.provide('workspaceRegistry', { list: () => [], resolveByPath: async () => undefined } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await pluginService(ctx, t, {
    memoryRoot: await isolatedMemoryRoot(t),
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

  assert.equal((await ctx.shioriRole.sessionSnapshot('legacy-blank')).locked, true)
  await assert.rejects(ctx.shioriRole.stageSessionRole('legacy-blank', 'writer'), /already bound/)
  assert.equal((domain.tables.get('session_roles')?.get('legacy-blank') as { roleId?: string })?.roleId, 'maintainer')
  dispose()
  await created.scope.dispose()
})

test('stores only attachment references in role assets and reads bytes through attachments', async t => {
  const ctx = new Context()
  const domain = memoryDomain()
  const attachments = attachmentService()
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('attachments', attachments.service as never)
  ctx.provide('workspaceRegistry', { resolveByPath: async () => undefined } as never)
  await pluginService(ctx, t, {
    memoryRoot: await isolatedMemoryRoot(t),
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

test('imports configured roles only once so deleted seeds do not reappear', async t => {
  const domain = memoryDomain()
  const memoryRoot = await isolatedMemoryRoot(t)
  const start = async () => {
    const ctx = new Context()
    ctx.provide('storageDomain', domain.service as never)
    ctx.provide('attachments', attachmentService().service as never)
    ctx.provide('workspaceRegistry', { resolveByPath: async () => undefined } as never)
    await pluginService(ctx, t, { roles: [{ id: 'seed', name: 'Seed', prompt: 'Seed prompt.' }], memoryRoot })
    return ctx
  }
  const first = await start()
  await first.shioriRole.deleteRole('seed')
  const second = await start()
  assert.deepEqual((await second.shioriRole.catalogSnapshot()).roles, [])
})

test('reassigns mutable references when their role is deleted', async t => {
  const ctx = new Context()
  const domain = memoryDomain()
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('attachments', attachmentService().service as never)
  ctx.provide('workspaceRegistry', { resolveByPath: async () => undefined } as never)
  await pluginService(ctx, t, {
    memoryRoot: await isolatedMemoryRoot(t),
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

test('hard-deletes roles retained by immutable sessions', async t => {
  const ctx = new Context()
  const domain = memoryDomain()
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('attachments', attachmentService().service as never)
  ctx.provide('workspaceRegistry', { resolveByPath: async () => undefined } as never)
  const memoryRoot = await isolatedMemoryRoot(t)
  await pluginService(ctx, t, {
    memoryRoot,
    roles: [
      { id: 'maintainer', name: 'Maintainer', prompt: 'Maintainer prompt.' },
      { id: 'writer', name: 'Writer', prompt: 'Writer prompt.' },
    ],
  })
  domain.tables.get('session_roles')?.set('bound-session', {
    roleId: 'maintainer', boundAt: '2026-08-14T00:00:00.000Z', bindingVersion: 2,
  })

  // Materialize role-owned memory so deletion must remove the SQLite store too.
  await ctx.shioriRole.memory().mutate({
    operation: 'upsert', memoryType: 'profile', summary: 'temporary durable memory',
    scope: { roleId: 'maintainer', sessionKey: 'bound-session' },
  })

  await ctx.shioriRole.deleteRole('maintainer')

  assert.deepEqual((await ctx.shioriRole.catalogSnapshot()).roles.map(role => role.id), ['writer'])
  const session = await ctx.shioriRole.sessionSnapshot('bound-session')
  assert.equal(session.roleId, undefined)
  assert.equal(session.roles.find(role => role.id === 'maintainer'), undefined)
  assert.equal(domain.tables.get('roles')?.has('maintainer'), false)
  assert.equal(domain.tables.get('session_roles')?.has('bound-session'), false)
  assert.equal(existsSync(join(memoryRoot, 'shiori-plugin', 'role', 'maintainer')), false)
  assert.equal(existsSync(join(memoryRoot, 'shiori-plugin', 'role', 'maintainer', 'memory', 'memory2.db')), false)
})

test('garbage-collects unreferenced local role attachments without deleting shared objects', async t => {
  const attachmentRoot = await mkdtemp(join(tmpdir(), 'shiori-role-attachments-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = attachmentRoot
  try {
    const ctx = new Context()
    const domain = memoryDomain()
    ctx.provide('storageDomain', domain.service as never)
    ctx.provide('attachments', attachmentService().service as never)
    ctx.provide('workspaceRegistry', { resolveByPath: async () => undefined } as never)
    await pluginService(ctx, t, {
      memoryRoot: await isolatedMemoryRoot(t),
      roles: [
        { id: 'owner', name: 'Owner', prompt: 'Owner prompt.' },
        { id: 'other', name: 'Other', prompt: 'Other prompt.' },
      ],
    })
    const unique = 'a'.repeat(64)
    const shared = 'b'.repeat(64)
    for (const hash of [unique, shared]) {
      const bucket = join(attachmentRoot, 'attachments', 'v1', 'objects', hash.slice(0, 2))
      mkdirSync(bucket, { recursive: true })
      writeFileSync(join(bucket, hash), 'fixture')
    }
    domain.tables.get('role_assets')?.set('owner-unique', {
      roleId: 'owner', purpose: 'avatar', attachment: { attachmentId: `sha256:${unique}` }, createdAt: '2026-08-15T00:00:00.000Z',
    })
    domain.tables.get('role_assets')?.set('owner-shared', {
      roleId: 'owner', purpose: 'portrait', attachment: { attachmentId: `sha256:${shared}` }, createdAt: '2026-08-15T00:00:00.000Z',
    })
    domain.tables.get('role_assets')?.set('other-shared', {
      roleId: 'other', purpose: 'avatar', attachment: { attachmentId: `sha256:${shared}` }, createdAt: '2026-08-15T00:00:00.000Z',
    })

    await ctx.shioriRole.deleteRole('owner')

    assert.equal(existsSync(join(attachmentRoot, 'attachments', 'v1', 'objects', 'aa', unique)), false)
    assert.equal(existsSync(join(attachmentRoot, 'attachments', 'v1', 'objects', 'bb', shared)), true)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(attachmentRoot, { recursive: true, force: true })
  }
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
  let serviceFiber: Awaited<ReturnType<Context['plugin']>> | undefined
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
    serviceFiber = await ctx.plugin(ShioriRoleService, {
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

    await waitFor(async () => (await ctx.shioriRole.memory().recall('maintainer')).some(item => item.summary.includes('咖啡')))
    const item = (await ctx.shioriRole.memory().recall('maintainer')).find(entry => entry.summary.includes('咖啡'))
    assert.equal(item?.kind, 'profile')
    assert.equal((item?.signals as Record<string, unknown> | undefined)?.category, 'personal_fact')
    assert.equal((item?.signals as Record<string, unknown> | undefined)?.emotional_weight, 4)
    assert.equal(item?.evidence?.[0]?.sourceRef, 'turn:1#profile')

    dispose()
    await created.scope.dispose()
  } finally {
    if (serviceFiber !== undefined) await serviceFiber.dispose()
    restore()
    await rm(root, { recursive: true, force: true })
  }
})

test('extracts durable memories through the current Harness model by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-role-harness-extraction-'))
  let serviceFiber: Awaited<ReturnType<Context['plugin']>> | undefined
  try {
    const ctx = new Context()
    const domain = memoryDomain()
    const requests: GenerateOptions[] = []
    ctx.provide('storageDomain', domain.service as never)
    ctx.provide('attachments', attachmentService().service as never)
    ctx.provide('workspaceRegistry', {
      list: () => [{ id: 'workspace-a', path: 'C:\\workspace' }],
      resolveByPath: async () => ({ id: 'workspace-a' }),
    } as never)
    ctx.provide('llm', {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        const text = options.system?.includes('新创建的角色')
          ? '# 我是谁\n\n## 我的性格与形象\n- 我是一个安静的角色。\n\n## 我对你的理解\n- 我还在认识你。\n\n## 我们的关系\n- 我们刚刚相遇。'
          : JSON.stringify({
            profile: [],
            preference: [{ summary: '用户偏好安静的工作环境', emotional_weight: 3 }],
            procedure: [],
          })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    serviceFiber = await ctx.plugin(ShioriRoleService, {
      roles: [{ id: 'maintainer', name: 'Maintainer', prompt: 'Maintainer prompt.' }],
      memoryRoot: root,
    })
    await ctx.shioriRole.select('workspace-a' as never, 'maintainer')

    const created = await agent(ctx, 'session-harness-extract', 'C:\\workspace')
    const dispose = ctx.agents.register(created.agent)
    const initialAssembly = await ctx.systemPrompt.assemble({ agent: created.agent, scope: created.agent })
    const initialPrompt = renderPrompt(initialAssembly)

    const session = created.agent.session as Session
    session.append('turn/start', { turn: 1 })
    session.append('user/message', {
      id: 'u-harness', role: 'user', content: [{ type: 'text', text: '我工作时喜欢安静' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'a-harness', role: 'assistant', content: [{ type: 'text', text: '我会记住。' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
    }, { surfaceOp: 'append' })

    await agentEvents(ctx, created.agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })

    assert.equal(requests.length, 2)
    const extractionRequest = requests.find(request => request.system?.includes('长期记忆提取器'))
    assert.ok(extractionRequest)
    assert.equal(extractionRequest.provider, 'deepseek')
    assert.equal(extractionRequest.model, 'deepseek-chat')
    assert.match(extractionRequest.system ?? '', /长期记忆提取器/)
    assert.match(String(extractionRequest.messages[0]?.content[0]?.type === 'text'
      ? extractionRequest.messages[0].content[0].text
      : ''), /喜欢安静/)
    assert.equal(session.events.some(event =>
      event.type === 'shiori-role/memory-extraction-request'
      && event.data.turn === 1
      && event.data.roleId === 'maintainer'
      && event.data.route.provider === 'deepseek'), true)
    const recalled = await ctx.shioriRole.memory().recall('maintainer')
    assert.equal(
      recalled.some(item => item.summary === '用户偏好安静的工作环境'),
      true,
      JSON.stringify(recalled),
    )
    const updatedAssembly = await ctx.systemPrompt.assemble({ agent: created.agent, scope: created.agent })
    assert.notEqual(renderPrompt(updatedAssembly), initialPrompt)
    assert.match(renderPrompt(updatedAssembly), /我们刚刚相遇/)
    assert.equal(updatedAssembly.contexts.some(context => context.text.includes('用户偏好安静的工作环境')), true)

    dispose()
    await created.scope.dispose()
  } finally {
    if (serviceFiber !== undefined) await serviceFiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('generates SELF.md when a newly created role first enters an LLM-backed session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-role-self-seed-session-'))
  let serviceFiber: Awaited<ReturnType<Context['plugin']>> | undefined
  try {
    const ctx = new Context()
    const domain = memoryDomain()
    const requests: GenerateOptions[] = []
    ctx.provide('storageDomain', domain.service as never)
    ctx.provide('attachments', attachmentService().service as never)
    ctx.provide('workspaceRegistry', {
      list: () => [{ id: 'workspace-a', path: 'C:\\workspace' }],
      resolveByPath: async () => ({ id: 'workspace-a' }),
    } as never)
    ctx.provide('llm', {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        const text = '# 我是谁\n\n## 我的性格与形象\n- 我是吟风。\n\n## 我对你的理解\n- 我还在认识你。\n\n## 我们的关系\n- 我们刚刚相遇。'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    serviceFiber = await ctx.plugin(ShioriRoleService, {
      roles: [{ id: 'new-role', name: 'New role', prompt: 'You are a new role.' }],
      memoryRoot: root,
    })
    await ctx.shioriRole.select('workspace-a' as never, 'new-role')

    const created = await agent(ctx, 'session-self-seed', 'C:\\workspace')
    Object.assign(created.agent.options, { provider: 'deepseek', model: 'deepseek-chat' })
    const dispose = ctx.agents.register(created.agent)
    const session = created.agent.session as Session
    session.append('turn/start', { turn: 1 })
    await agentEvents(ctx, created.agent).serial('agent/turn-stopping', {
      turn: 1,
      signal: new AbortController().signal,
    })
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent: created.agent, scope: created.agent }))

    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.provider, 'deepseek')
    assert.equal(requests[0]?.model, 'deepseek-chat')
    assert.match(requests[0]?.system ?? '', /新创建的角色生成首版 SELF\.md/)
    assert.match(prompt, /我们刚刚相遇/)
    dispose()
    await created.scope.dispose()
  } finally {
    if (serviceFiber !== undefined) await serviceFiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('maintains the complete Shiori Markdown and SQLite layers after successful compaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-role-compaction-'))
  let serviceFiber: Awaited<ReturnType<Context['plugin']>> | undefined
  try {
    const ctx = new Context()
    const domain = memoryDomain()
    const requests: GenerateOptions[] = []
    ctx.provide('storageDomain', domain.service as never)
    ctx.provide('attachments', attachmentService().service as never)
    ctx.provide('workspaceRegistry', {
      list: () => [{ id: 'workspace-a', path: 'C:\\workspace' }],
      resolveByPath: async () => ({ id: 'workspace-a' }),
    } as never)
    ctx.provide('llm', {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        const text = options.system?.includes('Markdown 记忆提取器')
          ? JSON.stringify({
            history_entries: [{ summary: '[2026-08-14 20:00] 你和我确认要直接沿用 Shiori 的 SELF.md 维护方式。', emotional_weight: 4 }],
            pending_items: [{ tag: 'preference', content: '你重视角色关系记忆的连续维护。' }],
          })
          : options.system?.includes('长期记忆整理器')
            ? '# 我的长期记忆\n\n## 关于你\n\n## 你的偏好\n- 你重视角色关系记忆的连续维护。\n\n## 你希望我记住的事'
            : options.system?.includes('SELF.md')
              ? '# 我是谁\n\n## 我的性格与形象\n- 我是维护记忆的角色。\n\n## 我对你的理解\n- 我知道你重视关系记忆的连续维护。\n\n## 我们的关系\n- 我们共同维护这份连续记忆。'
              : JSON.stringify({
                active_topics: ['你在维护 Shiori 的角色记忆'],
                user_preferences: [], follow_ups: [], avoidances: [], ongoing_threads: [],
              })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as never)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    serviceFiber = await ctx.plugin(ShioriRoleService, {
      roles: [{ id: 'maintainer', name: 'Maintainer', prompt: 'Maintainer prompt.' }],
      memoryRoot: root,
    })
    await ctx.shioriRole.select('workspace-a' as never, 'maintainer')

    const created = await agent(ctx, 'session-compaction', 'C:\\workspace')
    const dispose = ctx.agents.register(created.agent)
    renderPrompt(await ctx.systemPrompt.assemble({ agent: created.agent, scope: created.agent }))
    const session = created.agent.session as Session
    session.append('turn/start', { turn: 1 })
    const user = session.append('user/message', {
      id: 'u-compaction', role: 'user', content: [{ type: 'text', text: 'SELF.md 直接沿用 Shiori 的维护方式。' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    const assistant = session.append('assistant/message', {
      turn: 1, step: 1,
      message: { id: 'a-compaction', role: 'assistant', content: [{ type: 'text', text: '明白。' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } },
    }, { surfaceOp: 'append' })
    const compactionId = 'compaction-test' as never
    session.append('compaction/start', { compactionId, turn: null })
    session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: user.seq, end: assistant.seq },
      shadowedSeqs: [user.seq, assistant.seq],
      shadowedTokenCount: 20,
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    const ended = session.append('compaction/end', { compactionId, turn: null })
    ctx.emit('session/event', session, ended)

    await waitFor(async () => (await ctx.shioriRole.memory().recall('maintainer'))
      .some(item => item.kind === 'event' && item.summary.includes('沿用 Shiori')), 4000)
    const memoryDir = join(root, 'shiori-plugin', 'role', 'maintainer', 'memory')
    await waitFor(async () => (await readFile(join(memoryDir, 'SELF.md'), 'utf8'))
      .includes('共同维护这份连续记忆'), 4000)
    assert.match(await readFile(join(memoryDir, 'HISTORY.md'), 'utf8'), /直接沿用 Shiori/)
    assert.match(await readFile(join(memoryDir, 'MEMORY.md'), 'utf8'), /连续维护/)
    assert.equal((await readFile(join(memoryDir, 'PENDING.md'), 'utf8')).trim(), '# 待整理的记忆')
    assert.match(await readFile(join(memoryDir, 'RECENT_CONTEXT.md'), 'utf8'), /维护 Shiori 的角色记忆/)
    assert.equal((await ctx.shioriRole.memory().recall('maintainer'))
      .some(item => item.kind === 'preference' && item.summary.includes('连续维护')), true)
    const assembly = await ctx.systemPrompt.assemble({ agent: created.agent, scope: created.agent })
    assert.equal(assembly.contexts.some(context => context.text.includes('我的长期记忆')), true)
    assert.equal(assembly.contexts.some(context => context.text.includes('最近发生的事')), true)
    assert.equal(assembly.contexts.some(context => context.text.includes('## 最近的对话')), false)
    assert.equal(requests.length, 4)
    assert.deepEqual(
      session.events
        .filter(event => event.type === 'shiori-role/semantic-maintenance-request')
        .map(event => event.type === 'shiori-role/semantic-maintenance-request' ? event.data.purpose : ''),
      ['consolidation', 'memory-merge', 'self-update', 'recent-context'],
    )

    ctx.emit('session/event', session, ended)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(requests.length, 4)

    dispose()
    await created.scope.dispose()
  } finally {
    if (serviceFiber !== undefined) await serviceFiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('persists memory configuration and hot-applies it to the engine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-role-memconfig-'))
  let serviceFiber: Awaited<ReturnType<Context['plugin']>> | undefined
  try {
    const ctx = new Context()
    const domain = memoryDomain()
    ctx.provide('storageDomain', domain.service as never)
    ctx.provide('attachments', attachmentService().service as never)
    ctx.provide('workspaceRegistry', { resolveByPath: async () => undefined } as never)
    serviceFiber = await ctx.plugin(ShioriRoleService, {
      roles: [{ id: 'maintainer', name: 'Maintainer', prompt: 'Prompt.' }],
      memoryRoot: root,
    })

    // 未配置时为空快照
    assert.deepEqual(await ctx.shioriRole.memoryConfigSnapshot(), {})

    // 保存 embedding + extraction → KV 持久化 + 快照返回
    const saved = await ctx.shioriRole.saveMemoryConfig({
      embedding: { endpoint: 'https://embedding.test/v1', model: 'text-embedding-v3' },
      extraction: { endpoint: 'https://chat.test/v1', model: 'gpt-4o-mini', apiKey: 'secret' },
    })
    assert.equal(saved.embedding?.endpoint, 'https://embedding.test/v1')
    assert.equal(saved.extraction?.apiKey, 'secret')
    assert.ok(saved.updatedAt)
    const stored = domain.tables.get('memory_config')?.get('config') as { embedding?: { model?: string }; extraction?: { apiKey?: string } } | undefined
    assert.equal(stored?.embedding?.model, 'text-embedding-v3')
    assert.equal(stored?.extraction?.apiKey, 'secret')

    // 引擎热生效：保存后再写入记忆，embedding 端点应被调用
    const restore = stubFetchChat((url, init) => {
      if (!url.endsWith('/embeddings')) throw new Error(`unexpected url ${url}`)
      const body = JSON.parse(String(init?.body)) as { input: string[] }
      return jsonResponse({ data: body.input.map((text, index) => ({ index, embedding: [0.1, 0.2, 0.3] })) })
    })
    try {
      const result = await ctx.shioriRole.memory().mutate({
        kind: 'remember',
        scope: { roleId: 'maintainer' },
        summary: 'Hot-applied embedding works.',
      })
      assert.equal(result.accepted, true)
    } finally {
      restore()
    }

    // 清空配置 → 端点回到空（updatedAt 保留为最后修改时间）
    const cleared = await ctx.shioriRole.saveMemoryConfig({})
    assert.equal(cleared.embedding, undefined)
    assert.equal(cleared.extraction, undefined)
  } finally {
    if (serviceFiber !== undefined) await serviceFiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
