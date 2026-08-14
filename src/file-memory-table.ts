import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { roleMemoryRecord, type StoredRoleMemoryRecord } from './spec.ts'

type FileRow = { id: string; record: unknown }

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

  private load() {
    const roleRoot = join(this.workspaceRoot, 'shiori-plugin', 'role')
    mkdirSync(roleRoot, { recursive: true })
    for (const roleDir of readdirSync(roleRoot, { withFileTypes: true })) {
      if (!roleDir.isDirectory()) continue
      const path = join(roleRoot, roleDir.name, 'memory', 'memory.json')
      try {
        const payload = JSON.parse(readFileSync(path, 'utf8')) as unknown
        if (!Array.isArray(payload)) continue
        for (const item of payload as FileRow[]) {
          const parsed = roleMemoryRecord.safeParse(item.record)
          if (parsed.success && typeof item.id === 'string') this.values.set(item.id, parsed.data)
        }
      } catch { /* A missing or partial file is repaired on the next write. */ }
    }
  }

  private async persistRole(roleId: string) {
    const roleDir = join(this.workspaceRoot, 'shiori-plugin', 'role', encodeURIComponent(roleId), 'memory')
    mkdirSync(roleDir, { recursive: true })
    const payload: FileRow[] = [...this.values.entries()]
      .filter(([, item]) => item.roleId === roleId)
      .map(([id, record]) => ({ id, record }))
    const path = join(roleDir, 'memory.json')
    this.writeChain = this.writeChain.then(() => {
      if (payload.length === 0) {
        try { unlinkSync(path) } catch { /* Already absent. */ }
        return
      }
      writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    })
    await this.writeChain
  }
}
