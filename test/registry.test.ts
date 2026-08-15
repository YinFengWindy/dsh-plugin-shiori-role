import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DuplicateRoleError,
  MemoryRoleSelectionStore,
  UnknownRoleError,
  WorkspaceRoleRegistry,
} from '../src/index.ts'

const roles = [
  { id: 'maintainer', name: 'Maintainer', prompt: 'Maintain this workspace.' },
  { id: 'writer', name: 'Writer', prompt: 'Write for this workspace.' },
] as const

test('selects a role per workspace and keeps workspaces independent', async () => {
  const registry = new WorkspaceRoleRegistry(roles, new MemoryRoleSelectionStore())

  await registry.select('workspace-a', 'maintainer')
  await registry.select('workspace-b', 'writer')

  assert.equal((await registry.active('workspace-a'))?.id, 'maintainer')
  assert.equal((await registry.active('workspace-b'))?.id, 'writer')
})

test('rejects unknown and duplicate roles before persistence', async () => {
  const selections = new MemoryRoleSelectionStore()
  const registry = new WorkspaceRoleRegistry(roles, selections)

  await assert.rejects(() => registry.select('workspace-a', 'missing'), UnknownRoleError)
  await assert.rejects(
    async () => new WorkspaceRoleRegistry([...roles, roles[0]], selections),
    DuplicateRoleError,
  )
  assert.equal(await selections.get('workspace-a'), undefined)
})

test('a changed selection is visible only to a later resolution', async () => {
  const registry = new WorkspaceRoleRegistry(roles, new MemoryRoleSelectionStore())

  await registry.select('workspace-a', 'maintainer')
  const sessionRoleId = (await registry.active('workspace-a'))?.id

  await registry.select('workspace-a', 'writer')

  assert.equal(sessionRoleId, 'maintainer')
  assert.equal((await registry.active('workspace-a'))?.id, 'writer')
})
