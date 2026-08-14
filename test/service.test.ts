import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ShioriRoleService } from '../src/service.ts'

function memoryDomain() {
  const tables = new Map<string, Map<string, unknown>>()
  return {
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
  }
}

test('persists a workspace default and binds it once to a new Agent scope', async () => {
  const ctx = new Context()
  ctx.provide('storageDomain', memoryDomain() as never)
  ctx.provide('workspaceRegistry', {
    resolveByPath: async () => ({ id: 'workspace-a' }),
  } as never)
  await ctx.plugin(SystemPrompt, { persona: 'Deployment identity.' })
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
