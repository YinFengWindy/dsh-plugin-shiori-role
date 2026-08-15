import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_HISTORY_MD,
  DEFAULT_MEMORY_MD,
  DEFAULT_PENDING_MD,
  DEFAULT_RECENT_CONTEXT_MD,
  DEFAULT_SELF_MD,
  normalizeSelfDocument,
  RoleFiles,
} from '../src/role-files.ts'
import { RoleSelfMemory } from '../src/self-memory.ts'

test('persists role.json with the complete Shiori Markdown memory layer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-role-files-'))
  try {
    new RoleFiles(root).writeRoleDefinition({ id: 'yin-feng', name: '吟风', prompt: '角色提示词' })
    const roleDir = join(root, 'shiori-plugin', 'role', 'yin-feng')
    assert.match(await readFile(join(roleDir, 'role.json'), 'utf8'), /吟风/)
    const memoryDir = join(roleDir, 'memory')
    assert.deepEqual((await readdir(memoryDir)).filter(name => name.endsWith('.md')).sort(), [
      'HISTORY.md', 'MEMORY.md', 'PENDING.md', 'RECENT_CONTEXT.md', 'SELF.md',
    ])
    assert.equal(await readFile(join(memoryDir, 'SELF.md'), 'utf8'), DEFAULT_SELF_MD)
    assert.equal(await readFile(join(memoryDir, 'MEMORY.md'), 'utf8'), DEFAULT_MEMORY_MD)
    assert.equal(await readFile(join(memoryDir, 'HISTORY.md'), 'utf8'), DEFAULT_HISTORY_MD)
    assert.equal(await readFile(join(memoryDir, 'PENDING.md'), 'utf8'), DEFAULT_PENDING_MD)
    assert.equal(await readFile(join(memoryDir, 'RECENT_CONTEXT.md'), 'utf8'), DEFAULT_RECENT_CONTEXT_MD)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('snapshots, commits, and rolls back pending candidates without losing later appends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-role-pending-'))
  try {
    const files = new RoleFiles(root)
    files.writeRoleDefinition({ id: 'yin-feng', name: '吟风', prompt: '角色提示词' })
    files.appendPending('yin-feng', 'first', '- [identity] 你维护 Shiori')
    assert.match(files.snapshotPending('yin-feng'), /维护 Shiori/)
    files.appendPending('yin-feng', 'second', '- [preference] 你重视连续记忆')
    files.rollbackPendingSnapshot('yin-feng')
    assert.match(files.readPending('yin-feng'), /维护 Shiori/)
    assert.match(files.readPending('yin-feng'), /连续记忆/)

    assert.match(files.snapshotPending('yin-feng'), /维护 Shiori/)
    files.commitPendingSnapshot('yin-feng')
    assert.equal(files.readPending('yin-feng'), '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('seeds and updates SELF.md with Shiori prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-role-self-'))
  try {
    const files = new RoleFiles(root)
    files.writeRoleDefinition({ id: 'yin-feng', name: '吟风', introduction: '风中的旅人', prompt: '你是吟风。' })
    const requests: string[] = []
    const chat = {
      async chat(messages: readonly { readonly content: string }[]): Promise<string> {
        requests.push(messages.map(message => message.content).join('\n'))
        return requests.length === 1
          ? '# 我是谁\n\n## 我的性格与形象\n- 我是吟风。\n\n## 我对你的理解\n- 我还在认识你。\n\n## 我们的关系\n- 我们刚刚相遇。'
          : '# 我是谁\n\n## 我的性格与形象\n- 我是吟风。\n\n## 我对你的理解\n- 我知道你很重视记忆。\n\n## 我们的关系\n- 我们一起维护记忆。'
      },
    }
    const self = new RoleSelfMemory(files)
    assert.equal(await self.seed({ id: 'yin-feng', name: '吟风', introduction: '风中的旅人', prompt: '你是吟风。' }, chat), true)
    assert.match(self.read('yin-feng'), /我们刚刚相遇/)
    assert.equal(await self.update('yin-feng', '- [preference] 你很重视记忆', chat), true)
    assert.match(self.read('yin-feng'), /一起维护记忆/)
    assert.match(requests[0]!, /你是吟风/)
    assert.match(requests[1]!, /待合并事实/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects SELF output that describes the role from an outside viewpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-role-self-perspective-'))
  try {
    const files = new RoleFiles(root)
    const role = { id: 'yin-feng', name: '吟风', introduction: '风中的旅人', prompt: '你是吟风。' }
    files.writeRoleDefinition(role)
    const invalid = {
      async chat(): Promise<string> {
        return '# 我是谁\n\n## 我的性格与形象\n- 吟风是一个安静的旅人。\n\n## 我对你的理解\n- 用户还没有留下足够信息。\n\n## 我们的关系\n- 吟风与用户刚刚相遇。'
      },
    }
    const self = new RoleSelfMemory(files)
    assert.equal(await self.seed(role, invalid), false)
    assert.equal(self.read(role.id), DEFAULT_SELF_MD.trim())

    const valid = {
      async chat(): Promise<string> {
        return '# 我是谁\n\n## 我的性格与形象\n- 我是吟风，安静地观察风中的变化。\n\n## 我对你的理解\n- 我还在认识你。\n\n## 我们的关系\n- 我们刚刚相遇。'
      },
    }
    assert.equal(await self.seed(role, valid), true)
    assert.match(self.read(role.id), /我是吟风/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('normalizes SELF.md to Shiori three-section schema', () => {
  const normalized = normalizeSelfDocument('# 角色自我认知\n\n## 人格与形象\n- 风\n\n## 关系演进记录\n- 不保留\n\n## 我们关系的定义\n- 同行')
  assert.match(normalized, /^# 我是谁/)
  assert.match(normalized, /## 我的性格与形象/)
  assert.match(normalized, /## 我们的关系/)
  assert.doesNotMatch(normalized, /关系演进记录|不保留/)
})

test('rejects traversal through role ids', () => {
  assert.throws(
    () => new RoleFiles('C:/tmp').writeRoleDefinition({ id: '../escape', name: 'bad', prompt: 'bad' }),
    /invalid role id/,
  )
})

test('fails loudly when a persisted role definition is malformed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiori-role-invalid-definition-'))
  try {
    const roleDir = join(root, 'shiori-plugin', 'role', 'broken')
    await mkdir(roleDir, { recursive: true })
    await writeFile(join(roleDir, 'role.json'), '{not-json', 'utf8')
    assert.throws(() => new RoleFiles(root).listRoleDefinitions(), /failed to read role definition 'broken'/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
