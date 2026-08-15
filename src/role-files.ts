import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_SELF_MD = `# 我是谁

## 我的性格与形象
- 我以自己的身份表达，并遵守角色设定中的人格、语气和边界。

## 我对你的理解
- 我只根据你明确表达或确认过的信息逐步理解你，不在缺少证据时补全画像。

## 我们的关系
- 我们的关系从真实互动中发展，不虚构共同经历。
`
export const DEFAULT_MEMORY_MD = `# 我的长期记忆

## 关于你

## 你的偏好

## 你希望我记住的事
`
export const DEFAULT_HISTORY_MD = '# 我们的共同经历\n'
export const DEFAULT_PENDING_MD = '# 待整理的记忆\n'
export const DEFAULT_RECENT_CONTEXT_MD = `# 最近发生的事

## 最近聊过的事
- none

## 还在继续的事
- none

## 最近的对话
<!-- a-preview = assistant reply preview only -->
- none
`

/** Persist the editable role definition beside its role-owned memory directory. */
export class RoleFiles {
  constructor(private readonly root: string) {}

  writeRoleDefinition(role: {
    readonly id: string
    readonly name: string
    readonly introduction?: string
    readonly prompt: string
    readonly createdAt?: string
    readonly updatedAt?: string
  }): void {
    const dir = join(this.root, 'shiori-plugin', 'role', safeRoleId(role.id))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'role.json'), JSON.stringify(role, null, 2) + '\n', 'utf8')
    this.ensureDocuments(role.id)
  }

  /** Read role definitions left on disk by an earlier plugin process. */
  listRoleDefinitions(): readonly {
    readonly id: string
    readonly name: string
    readonly introduction: string
    readonly prompt: string
    readonly createdAt: string
    readonly updatedAt: string
  }[] {
    const root = join(this.root, 'shiori-plugin', 'role')
    try {
      return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
        if (!entry.isDirectory()) return []
        const id = entry.name
        try {
          const value = JSON.parse(readFileSync(join(root, id, 'role.json'), 'utf8')) as Record<string, unknown>
          if (value.deletedAt !== undefined) return []
          const name = typeof value.name === 'string' ? value.name.trim() : ''
          const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : ''
          const createdAt = typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString()
          const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : createdAt
          return name && prompt ? [{ id, name, prompt, introduction: typeof value.introduction === 'string' ? value.introduction : '', createdAt, updatedAt }] : []
        } catch {
          return []
        }
      })
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return []
      throw error
    }
  }

  /** Mark a deleted role file so startup migration cannot resurrect it. */
  removeRoleDefinition(roleId: string): void {
    const path = join(this.roleDir(roleId), 'role.json')
    try {
      const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      writeFileSync(path, JSON.stringify({ ...current, deletedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    }
  }

  /** Ensure all canonical Shiori role-memory documents exist. */
  ensureDocuments(roleId: string): void {
    mkdirSync(this.roleDir(roleId), { recursive: true })
    mkdirSync(this.memoryDir(roleId), { recursive: true })
    for (const [name, content] of Object.entries({
      'SELF.md': DEFAULT_SELF_MD,
      'MEMORY.md': DEFAULT_MEMORY_MD,
      'HISTORY.md': DEFAULT_HISTORY_MD,
      'PENDING.md': DEFAULT_PENDING_MD,
      'RECENT_CONTEXT.md': DEFAULT_RECENT_CONTEXT_MD,
    })) this.ensureFile(join(this.memoryDir(roleId), name), content)
  }

  /** Read the current role-self document. */
  readSelf(roleId: string): string {
    this.ensureDocuments(roleId)
    return readFileSync(this.selfPath(roleId), 'utf8').trim()
  }

  /** Replace the role-self document with normalized Shiori content. */
  writeSelf(roleId: string, content: string): void {
    this.ensureDocuments(roleId)
    writeFileSync(this.selfPath(roleId), normalizeSelfDocument(content), 'utf8')
  }

  readMemory(roleId: string): string {
    this.ensureDocuments(roleId)
    return readFileSync(join(this.memoryDir(roleId), 'MEMORY.md'), 'utf8').trim()
  }

  writeMemory(roleId: string, content: string): void {
    this.ensureDocuments(roleId)
    writeFileSync(join(this.memoryDir(roleId), 'MEMORY.md'), normalizeMemoryDocument(content), 'utf8')
  }

  readPending(roleId: string): string {
    this.ensureDocuments(roleId)
    return pendingBody(readFileSync(this.pendingPath(roleId), 'utf8'))
  }

  appendPending(roleId: string, sourceRef: string, content: string): void {
    this.ensureDocuments(roleId)
    const raw = readFileSync(this.pendingPath(roleId), 'utf8')
    if (!content.trim() || raw.includes(`<!-- consolidation: ${sourceRef} -->`)) return
    const body = raw.replace(/^# 待整理的记忆\s*/, '').trim()
    const next = [
      '# 待整理的记忆',
      '',
      `<!-- consolidation: ${sourceRef} -->`,
      content.trim(),
      ...(body ? ['', body] : []),
      '',
    ].join('\n')
    writeFileSync(join(this.memoryDir(roleId), 'PENDING.md'), next, 'utf8')
  }

  clearPending(roleId: string): void {
    this.ensureDocuments(roleId)
    writeFileSync(this.pendingPath(roleId), DEFAULT_PENDING_MD, 'utf8')
  }

  /** Atomically isolate current pending candidates from later appends. */
  snapshotPending(roleId: string): string {
    this.ensureDocuments(roleId)
    this.recoverPendingSnapshot(roleId)
    const pending = this.readPending(roleId)
    if (!pending) return ''
    renameSync(this.pendingPath(roleId), this.pendingSnapshotPath(roleId))
    writeFileSync(this.pendingPath(roleId), DEFAULT_PENDING_MD, 'utf8')
    return pending
  }

  /** Remove a pending snapshot after both optimizers accepted it. */
  commitPendingSnapshot(roleId: string): void {
    const snapshot = this.pendingSnapshotPath(roleId)
    if (existsSync(snapshot)) unlinkSync(snapshot)
    this.ensureFile(this.pendingPath(roleId), DEFAULT_PENDING_MD)
  }

  /** Restore an optimizer snapshot before candidates appended while it ran. */
  rollbackPendingSnapshot(roleId: string): void {
    const snapshot = this.pendingSnapshotPath(roleId)
    if (!existsSync(snapshot)) return
    const older = readFileSync(snapshot, 'utf8').trimEnd()
    const newer = existsSync(this.pendingPath(roleId))
      ? readFileSync(this.pendingPath(roleId), 'utf8').replace(/^# 待整理的记忆\s*/, '').trim()
      : ''
    writeFileSync(this.pendingPath(roleId), `${older}${newer ? `\n${newer}` : ''}\n`, 'utf8')
    unlinkSync(snapshot)
  }

  appendHistory(roleId: string, sourceRef: string, entries: readonly string[]): void {
    if (entries.length === 0) return
    this.ensureDocuments(roleId)
    const path = join(this.memoryDir(roleId), 'HISTORY.md')
    const current = readFileSync(path, 'utf8').trim()
    if (current.includes(`<!-- consolidation: ${sourceRef} -->`)) return
    const body = entries.map(entry => entry.trim()).filter(Boolean).join('\n\n')
    writeFileSync(path, `${current}\n\n<!-- consolidation: ${sourceRef} -->\n\n${body}\n`, 'utf8')
  }

  writeRecentContext(roleId: string, content: string): void {
    this.ensureDocuments(roleId)
    writeFileSync(join(this.memoryDir(roleId), 'RECENT_CONTEXT.md'), normalizeRecentContext(content), 'utf8')
  }

  readRecentContext(roleId: string): string {
    this.ensureDocuments(roleId)
    return readFileSync(join(this.memoryDir(roleId), 'RECENT_CONTEXT.md'), 'utf8').trim()
  }

  private roleDir(roleId: string): string {
    return join(this.root, 'shiori-plugin', 'role', safeRoleId(roleId))
  }

  private memoryDir(roleId: string): string {
    return join(this.roleDir(roleId), 'memory')
  }

  private selfPath(roleId: string): string {
    return join(this.memoryDir(roleId), 'SELF.md')
  }

  private pendingPath(roleId: string): string {
    return join(this.memoryDir(roleId), 'PENDING.md')
  }

  private pendingSnapshotPath(roleId: string): string {
    return join(this.memoryDir(roleId), 'PENDING.snapshot.md')
  }

  private recoverPendingSnapshot(roleId: string): void {
    if (existsSync(this.pendingSnapshotPath(roleId))) this.rollbackPendingSnapshot(roleId)
  }

  private ensureFile(path: string, content: string): void {
    try {
      readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
      writeFileSync(path, content, 'utf8')
    }
  }
}

function pendingBody(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/^# 待整理的记忆\s*/, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('<!-- consolidation:'))
    .join('\n')
    .trim()
}

const SELF_SECTIONS = ['## 我的性格与形象', '## 我对你的理解', '## 我们的关系'] as const

/** Keep only Shiori's canonical SELF.md title and three sections. */
export function normalizeSelfDocument(content: string): string {
  const text = content.replace(/\r\n/g, '\n').replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```$/, '').trim()
  if (!text) return DEFAULT_SELF_MD
  const collected = new Map<string, string[]>()
  for (const section of SELF_SECTIONS) collected.set(section, [])
  let active: string | undefined
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim() === '## 人格与形象' ? '## 我的性格与形象'
      : rawLine.trim() === '## 我对当前用户的理解' ? '## 我对你的理解'
        : rawLine.trim() === '## 我们关系的定义' ? '## 我们的关系'
          : rawLine
    const heading = line.trim()
    if (SELF_SECTIONS.includes(heading as (typeof SELF_SECTIONS)[number])) {
      active = heading
      continue
    }
    if (heading.startsWith('#')) {
      active = undefined
      continue
    }
    if (active !== undefined) collected.get(active)!.push(line)
  }
  const lines = ['# 我是谁', '']
  for (const section of SELF_SECTIONS) {
    lines.push(section)
    const body = collected.get(section)!.join('\n').trim()
    if (body) lines.push('', ...body.split('\n'))
    lines.push('')
  }
  return lines.join('\n').trim() + '\n'
}

/** Normalize the three-section Shiori MEMORY.md projection. */
export function normalizeMemoryDocument(content: string): string {
  const aliases: Record<string, string> = {
    '## 用户事实': '## 关于你',
    '## 用户画像': '## 关于你',
    '## 用户偏好': '## 你的偏好',
    '## 用户明确要求长期记住的关键内容': '## 你希望我记住的事',
  }
  const sections = ['## 关于你', '## 你的偏好', '## 你希望我记住的事'] as const
  const collected = new Map<string, string[]>(sections.map(section => [section, []]))
  let active: string | undefined
  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = aliases[rawLine.trim()] ?? rawLine
    const heading = line.trim()
    if (sections.includes(heading as (typeof sections)[number])) { active = heading; continue }
    if (heading.startsWith('#')) { active = undefined; continue }
    if (active !== undefined && line.trim() !== '## 助手操作上下文' && line.trim() !== '## 运行上下文') collected.get(active)!.push(line.replaceAll('用户', '你').replaceAll('助手', '我'))
  }
  const lines = ['# 我的长期记忆', '']
  for (const section of sections) {
    lines.push(section)
    const body = collected.get(section)!.join('\n').trim()
    if (body) lines.push('', ...body.split('\n'))
    lines.push('')
  }
  return lines.join('\n').trim() + '\n'
}

function normalizeRecentContext(content: string): string {
  const text = content.replace(/\r\n/g, '\n').replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```$/, '').trim()
  return text ? (text.startsWith('# 最近发生的事') ? text + '\n' : `# 最近发生的事\n\n${text}\n`) : DEFAULT_RECENT_CONTEXT_MD
}

function safeRoleId(roleId: string): string {
  const id = roleId.trim()
  if (!id || id.includes('..') || /[\\/]/.test(id)) throw new Error(`shiori-role: invalid role id '${roleId}'`)
  return id
}
