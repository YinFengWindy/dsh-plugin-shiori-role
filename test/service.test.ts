import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createScope, scopeOf, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ShioriRoleService } from '../src/service.ts'

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

test('persists a workspace default and binds it once to a new Agent scope', async () => {
  const ctx = new Context()
  const domain = memoryDomain()
  ctx.provide('storageDomain', domain.service as never)
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
  ctx.provide('storageDomain', domain.service as never)
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
  ctx.provide('storageDomain', domain.service as never)
  ctx.provide('workspaceRegistry', { resolveByPath: async () => undefined } as never)
  await ctx.plugin(ShioriRoleService, {
    roles: [{ id: 'maintainer', name: 'Maintainer', prompt: 'Private model prompt.' }],
  })

  assert.deepEqual(await ctx.shioriRole.snapshot('workspace-a'), {
    workspaceId: 'workspace-a',
    roles: [{ id: 'maintainer', name: 'Maintainer' }],
  })
  assert.deepEqual(await ctx.shioriRole.selectRemote('workspace-a', 'maintainer'), {
    workspaceId: 'workspace-a',
    roles: [{ id: 'maintainer', name: 'Maintainer' }],
    activeRoleId: 'maintainer',
  })
})
