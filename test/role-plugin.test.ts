import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { apply as applyRole } from '../src/role-plugin.ts'

test('mounts role identity in an Agent scope and removes it on disposal', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: 'Deployment identity.' })

  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, { role: 'maintainer' })
  }, { inject: ['systemPrompt'] }))

  await scope.ctx.plugin(applyRole, {
    id: 'maintainer',
    name: 'Maintainer',
    prompt: 'You are the Shiori maintainer for this workspace.',
  })

  const scopedBefore = renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeOf(scope.ctx)! }))
  assert.match(scopedBefore, /Shiori maintainer/)
  assert.doesNotMatch(scopedBefore, /Deployment identity/)

  await scope.dispose()

  const scopedAfter = renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeOf(scope.ctx)! }))
  assert.doesNotMatch(scopedAfter, /Shiori maintainer/)
})
