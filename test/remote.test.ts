import assert from 'node:assert/strict'
import test from 'node:test'
import remote from '../src/remote.ts'

test('publishes strict snapshot and selection Remote descriptors', () => {
  assert.deepEqual(remote.descriptors.map(item => `${item.namespace}/${item.method}`), [
    'shioriRole/snapshot',
    'shioriRole/select',
  ])

  const snapshot = {
    workspaceId: 'workspace-a',
    roles: [{ id: 'maintainer', name: 'Maintainer' }],
    activeRoleId: 'maintainer',
  }
  for (const descriptor of remote.descriptors) {
    assert.deepEqual(descriptor.result.schema.parse(snapshot), snapshot)
    assert.throws(() => descriptor.result.schema.parse({ ...snapshot, roles: [{ id: 1, name: 'bad' }] }))
  }
})
