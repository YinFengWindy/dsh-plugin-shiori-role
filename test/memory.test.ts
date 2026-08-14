import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { applyMemoryTools, ShioriMemoryService } from '../src/memory.ts'

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

test('role memory is isolated and tools are scoped to the Agent context', async () => {
  const memory = new ShioriMemoryService(table())
  const saved = await memory.memorize('role-a', 'Only role A knows this.')
  assert.equal(memory.recall('role-b').length, 0)
  assert.equal(memory.recall('role-a')[0]?.content, 'Only role A knows this.')
  assert.equal(await memory.forget('role-b', `${saved.roleId}:missing`), false)

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const plugin = Object.assign((inner: Context) => applyMemoryTools(inner, memory, 'role-a'), { inject: ['systemPrompt', 'tools'] })
  const scope = await ctx.plugin(plugin)
  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), ['recall_memory', 'memorize', 'forget_memory'])
  await scope.dispose()
  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), [])
})
