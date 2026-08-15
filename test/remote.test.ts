import assert from 'node:assert/strict'
import test from 'node:test'
import remote from '../src/remote.ts'

test('publishes strict role catalog, asset, and session Remote descriptors', () => {
  assert.deepEqual(remote.descriptors.map(item => `${item.namespace}/${item.method}`), [
    'shioriRole/snapshot',
    'shioriRole/select',
    'shioriRole/catalogSnapshot',
    'shioriRole/saveRole',
    'shioriRole/deleteRole',
    'shioriRole/uploadAsset',
    'shioriRole/removeAsset',
    'shioriRole/assetData',
    'shioriRole/selectThemeBackground',
    'shioriRole/clearThemeBackground',
    'shioriRole/sessionSnapshot',
    'shioriRole/stageSessionRole',
    'shioriRole/memoryConfigSnapshot',
    'shioriRole/saveMemoryConfig',
  ])

  const memory = remote.descriptors.find(item => item.method === 'saveMemoryConfig')
  assert.deepEqual(memory?.result.schema.parse({
    embedding: { endpoint: 'https://e.test/v1', model: 'm' },
    extraction: { endpoint: 'https://c.test/v1', model: 'c', apiKey: 'k' },
  }), {
    embedding: { endpoint: 'https://e.test/v1', model: 'm' },
    extraction: { endpoint: 'https://c.test/v1', model: 'c', apiKey: 'k' },
  })

  const role = {
    id: 'maintainer', name: 'Maintainer', introduction: 'Maintains Shiori.', prompt: 'Prompt.', assets: [],
    createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
  }
  const catalog = remote.descriptors.find(item => item.method === 'catalogSnapshot')
  const session = remote.descriptors.find(item => item.method === 'sessionSnapshot')
  assert.deepEqual(catalog?.result.schema.parse({ roles: [role] }), { roles: [role] })
  assert.deepEqual(session?.result.schema.parse({ sessionId: 'session-a', roles: [role], pendingRoleId: 'maintainer', locked: false }), {
    sessionId: 'session-a', roles: [role], pendingRoleId: 'maintainer', locked: false,
  })
  assert.throws(() => catalog?.result.schema.parse({ roles: [{ ...role, assets: [{ id: 1 }] }] }))
})
