import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { roleMemoryRecord, type StoredRoleMemoryRecord } from './spec.ts'

type FileRow = { id: string; record: unknown }

const MARKDOWN_DEFAULTS: Readonly<Record<string, string>> = {
  'SELF.md': '# 我是谁\n\n## 我的性格与形象\n\n## 我对你的理解\n\n## 我们的关系\n',
  'MEMORY.md': '# 我的长期记忆\n\n## 关于你\n\n## 你的偏好\n\n## 你希望我记住的事\n',
  'HISTORY.md': '# 我们的共同经历\n',
  'RECENT_CONTEXT.md': '# 最近发生的事\n\n## 最近聊过的事\n- none\n\n## 还在继续的事\n- none\n',
  'PENDING.md': '# 待整理的记忆\n',
}

/** File-backed workspace memory table rooted below `shiori-plugin/role`. */
export class WorkspaceMemoryTable implements KvTable<string, StoredRoleMemoryRecord> {
  private readonly values = new Map<string, StoredRoleMemoryRecord>()
  private writeChain = Promise.resolve()

  constructor(private readonly workspaceRoot: string) {
    this.load()
  }

  get(key: string) { return this.values.get(key) }
  entries() { return this.values.entries() }
  keys() { return this.values.keys() }
  get size() { return this.values.size }

  async put(key: string, value: StoredRoleMemoryRecord) {
    this.values.set(key, value)
    await this.persistRole(value.roleId)
  }

  async delete(key: string) {
    const current = this.values.get(key)
    if (current === undefined) return false
    this.values.delete(key)
    await this.persistRole(current.roleId)
    return true
  }

  async update(key: string, fn: (current: StoredRoleMemoryRecord) => StoredRoleMemoryRecord) {
    const current = this.values.get(key)
    if (current === undefined) throw new Error(`shiori-role: missing memory key '${key}'`)
    const next = fn(current)
    await this.put(key, next)
    return next
  }

  /** Read the human-editable long-term Markdown layer for one role. */
  readMarkdown(roleId: string): string {
    const memoryDir = this.memoryDir(roleId)
    this.ensureMarkdownDocuments(memoryDir)
    return readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')
  }

  private load() {
    const roleRoot = join(this.workspaceRoot, 'shiori-plugin', 'role')
    mkdirSync(roleRoot, { recursive: true })
    for (const roleDir of readdirSync(roleRoot, { withFileTypes: true })) {
      if (!roleDir.isDirectory()) continue
      const memoryDir = join(roleRoot, roleDir.name, 'memory')
      this.ensureMarkdownDocuments(memoryDir)
      const semanticPath = join(memoryDir, 'semantic.json')
      const legacyPath = join(memoryDir, 'memory.json')
      try {
        let raw: string
        try { raw = readFileSync(semanticPath, 'utf8') } catch { raw = readFileSync(legacyPath, 'utf8') }
        const payload = JSON.parse(raw) as unknown
        if (!Array.isArray(payload)) continue
        for (const item of payload as FileRow[]) {
          const parsed = roleMemoryRecord.safeParse(item.record)
          if (parsed.success && typeof item.id === 'string') this.values.set(item.id, parsed.data)
        }
      } catch { /* A missing or partial file is repaired on the next write. */ }
    }
  }

  private async persistRole(roleId: string) {
    const roleDir = this.memoryDir(roleId)
    mkdirSync(roleDir, { recursive: true })
    this.ensureMarkdownDocuments(roleDir)
    const payload: FileRow[] = [...this.values.entries()]
      .filter(([, item]) => item.roleId === roleId)
      .map(([id, record]) => ({ id, record }))
    const path = join(roleDir, 'semantic.json')
    const legacyPath = join(roleDir, 'memory.json')
    this.writeChain = this.writeChain.then(() => {
      if (payload.length === 0) {
        try { unlinkSync(path) } catch { /* Already absent. */ }
        this.writeMemoryMarkdown(roleDir, [])
        return
      }
      writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8')
      try { unlinkSync(legacyPath) } catch { /* No legacy file to migrate. */ }
      this.writeMemoryMarkdown(roleDir, payload)
    })
    await this.writeChain
  }

  private memoryDir(roleId: string) {
    return join(this.workspaceRoot, 'shiori-plugin', 'role', encodeURIComponent(roleId), 'memory')
  }

  private ensureMarkdownDocuments(memoryDir: string) {
    mkdirSync(memoryDir, { recursive: true })
    for (const [filename, content] of Object.entries(MARKDOWN_DEFAULTS)) {
      const path = join(memoryDir, filename)
      try { readFileSync(path, 'utf8') } catch { writeFileSync(path, content, 'utf8') }
    }
  }

  private writeMemoryMarkdown(memoryDir: string, rows: readonly FileRow[]) {
    const records: StoredRoleMemoryRecord[] = []
    for (const row of rows) {
      const result = roleMemoryRecord.safeParse(row.record)
      if (result.success && result.data.status === 'active') records.push(result.data)
    }
    const existing = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8').trimEnd()
    const start = '<!-- shiori-role-semantic:start -->'
    const end = '<!-- shiori-role-semantic:end -->'
    const withoutManaged = existing.replace(new RegExp(`${start}[\\s\\S]*?${end}`, 'g'), '').trimEnd()
    const bullets = records.map(item => `- [${item.kind}/${item.domain}] ${item.summary ?? item.content}`).join('\n')
    const managed = [start, '## 语义记忆（自动同步）', bullets || '- none', end].join('\n')
    writeFileSync(join(memoryDir, 'MEMORY.md'), `${withoutManaged}\n\n${managed}\n`, 'utf8')
  }
}
