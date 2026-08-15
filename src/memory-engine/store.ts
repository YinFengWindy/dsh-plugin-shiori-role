/**
 * SQLite 记忆存储，1:1 复刻 Shiori `memory2/store/*`（common/connection/write/vector/admin/temporal）。
 * 使用 Node 内置 `node:sqlite`（零依赖）。向量检索走全表扫描（Shiori 的 sqlite-vec 回退路径）。
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { StoreHit } from './contracts.ts'
import { cosineSimilarity } from './llm.ts'

const VEC_DIM = 1024
const LOCAL_TZ_OFFSET_MS = 8 * 3600 * 1000 // Asia/Shanghai（仅用于无时区时间解析，保持 Shiori 语义）
const TIME_FILTER_MARGIN_DAYS = 2
const TIME_FILTER_KEYWORD_CANDIDATE_LIMIT = 1000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_items (
    id            TEXT PRIMARY KEY,
    memory_type   TEXT NOT NULL,
    summary       TEXT NOT NULL,
    content_hash  TEXT NOT NULL,
    embedding     TEXT,
    reinforcement INTEGER NOT NULL DEFAULT 1,
    emotional_weight INTEGER NOT NULL DEFAULT 0,
    extra_json    TEXT,
    source_ref    TEXT,
    happened_at   TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_items_hash
    ON memory_items (content_hash, memory_type);
CREATE TABLE IF NOT EXISTS consolidation_events (
    source_ref  TEXT PRIMARY KEY,
    item_id     TEXT,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS completed_compactions (
    source_ref  TEXT PRIMARY KEY,
    completed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consolidation_long_term_refs (
    source_ref  TEXT PRIMARY KEY,
    item_id     TEXT,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_replacements (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    old_item_id       TEXT NOT NULL,
    old_memory_type   TEXT NOT NULL,
    old_summary       TEXT NOT NULL,
    old_source_ref    TEXT,
    old_happened_at   TEXT,
    old_extra_json    TEXT,
    new_item_id       TEXT NOT NULL,
    new_memory_type   TEXT NOT NULL,
    new_summary       TEXT NOT NULL,
    new_source_ref    TEXT,
    new_happened_at   TEXT,
    new_extra_json    TEXT,
    relation_type     TEXT NOT NULL DEFAULT 'supersede',
    source_ref        TEXT,
    created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_memory_replacements_old_item
    ON memory_replacements (old_item_id, created_at);
CREATE INDEX IF NOT EXISTS ix_memory_replacements_new_item
    ON memory_replacements (new_item_id, created_at);
CREATE INDEX IF NOT EXISTS ix_items_status
    ON memory_items (status);
`

export function nowIso(): string {
  return new Date().toISOString()
}

/** sha256(空白归一化小写 summary + memory_type)[:16]，镜像 `_content_hash`。 */
export function contentHash(summary: string, memoryType: string): string {
  const text = summary.toLowerCase().replace(/\s+/g, ' ').trim() + memoryType
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function coerceEmotionalWeight(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value !== 'string' && typeof value !== 'number') return 0
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Math.trunc(value)
  if (Number.isNaN(parsed)) return 0
  return Math.max(0, Math.min(10, parsed))
}

function coerceInt(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Math.trunc(value)
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = Number.parseInt(String(value), 10)
    return Number.isNaN(parsed) ? fallback : parsed
  }
  return fallback
}

function coerceFloat(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isNaN(parsed) ? fallback : parsed
  }
  return fallback
}

function jsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(String(raw)) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function jsonEmbedding(raw: unknown): number[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(String(raw)) as unknown
    if (Array.isArray(parsed) && parsed.every(value => typeof value === 'number')) {
      return parsed as number[]
    }
  } catch { /* invalid embedding is skipped */ }
  return undefined
}

/** 热度分：频度 * 时间衰减，结果在 (0,1)。镜像 `_hotness_score`。 */
export function hotnessScore(
  reinforcement: number,
  updatedAt: string,
  now = Date.now(),
  halfLifeDays = 14,
  emotionalWeight = 0,
): number {
  const effectiveHalfLife = Math.max(halfLifeDays * (1 + 0.5 * coerceEmotionalWeight(emotionalWeight) / 10), 0.1)
  const freq = 1 / (1 + Math.exp(-Math.log1p(Math.max(0, reinforcement))))
  const updatedMs = Date.parse(updatedAt)
  if (Number.isNaN(updatedMs)) return 0
  const ageDays = Math.max((now - updatedMs) / 86_400_000, 0)
  const recency = Math.exp(-Math.LN2 / effectiveHalfLife * ageDays)
  return freq * recency
}

/** 解析记忆时间（无时区视为 Asia/Shanghai naive，镜像 `_parse_memory_time`）。 */
function parseMemoryTime(raw: unknown): number | undefined {
  const text = String(raw ?? '').trim()
  if (!text) return undefined
  let iso = text
  if (iso.endsWith('Z')) iso = `${iso.slice(0, -1)}+00:00`
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    // 尝试无时区 naive（按上海时区解释）
    const naive = Date.parse(`${text.replace(' ', 'T')}Z`) - LOCAL_TZ_OFFSET_MS
    return Number.isNaN(naive) ? undefined : naive
  }
  return ms
}

function memoryTimeInRange(raw: unknown, timeStartMs?: number, timeEndMs?: number): boolean {
  const ms = parseMemoryTime(raw)
  if (ms === undefined) return false
  if (timeStartMs !== undefined && ms < timeStartMs) return false
  if (timeEndMs !== undefined && ms >= timeEndMs) return false
  return true
}

function localNaiveIso(ms: number): string {
  return new Date(ms + LOCAL_TZ_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19)
}

function roleFilter(column = 'extra_json'): string {
  return `COALESCE(TRIM(json_extract(${column}, '$.role_id')), '') = ?`
}

function domainFilter(column = 'extra_json'): string {
  return `COALESCE(TRIM(json_extract(${column}, '$.memory_domain')), '') = ?`
}

export interface WriteOptions {
  readonly sourceRef?: string | undefined
  readonly extra?: Readonly<Record<string, unknown>> | undefined
  readonly happenedAt?: string | undefined
  readonly emotionalWeight?: number | undefined
}

export interface VectorSearchOptions {
  readonly topK?: number | undefined
  readonly memoryTypes?: readonly string[] | undefined
  readonly memoryDomains?: readonly string[] | undefined
  readonly scoreThreshold?: number | undefined
  readonly includeSuperseded?: boolean | undefined
  readonly roleId?: string | undefined
  readonly scopeChannel?: string | undefined
  readonly scopeChatId?: string | undefined
  readonly requireScopeMatch?: boolean | undefined
  readonly hotnessAlpha?: number | undefined
  readonly hotnessHalfLifeDays?: number | undefined
  readonly timeStart?: string | undefined
  readonly timeEnd?: string | undefined
}

export interface KeywordSearchOptions {
  readonly memoryTypes?: readonly string[] | undefined
  readonly memoryDomains?: readonly string[] | undefined
  readonly roleId?: string | undefined
  readonly limit?: number | undefined
  readonly timeStart?: string | undefined
  readonly timeEnd?: string | undefined
  readonly scopeChannel?: string | undefined
  readonly scopeChatId?: string | undefined
  readonly requireScopeMatch?: boolean | undefined
}

type EmbeddingRow = {
  id: string
  memoryType: string
  summary: string
  embedding: number[] | undefined
  extra: Record<string, unknown>
  happenedAt: string | undefined
  sourceRef: string | undefined
}

/**
 * SQLite-backed Shiori memory store（MemoryStore2 等价物）。
 * 线程安全：Node 单线程 + DatabaseSync 同步 API，无需锁。
 */
export class ShioriMemoryStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string, vecDim = VEC_DIM) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(SCHEMA)
    void vecDim
  }

  close(): void {
    this.db.close()
  }

  // -------------------------------------------------------------------------
  // 写入（memory2/store/write.py）
  // -------------------------------------------------------------------------

  /** 写入或强化一条记忆，返回 `new:<id>` 或 `reinforced:<id>`。 */
  upsertItem(
    memoryType: string,
    summary: string,
    embedding?: readonly number[],
    options: WriteOptions = {},
  ): string {
    const hash = contentHash(summary, memoryType)
    const emotionalWeight = coerceEmotionalWeight(options.emotionalWeight)
    const existing = this.db.prepare(
      'SELECT id, status FROM memory_items WHERE content_hash=? AND memory_type=?',
    ).get(hash, memoryType) as { id: string; status: string } | undefined
    if (existing) {
      if (existing.status === 'superseded') {
        this.db.prepare(
          "UPDATE memory_items SET status='active', reinforcement=reinforcement+1, updated_at=?, emotional_weight=MAX(emotional_weight, ?) WHERE id=?",
        ).run(nowIso(), emotionalWeight, existing.id)
      } else {
        this.db.prepare(
          'UPDATE memory_items SET reinforcement=reinforcement+1, updated_at=?, emotional_weight=MAX(emotional_weight, ?) WHERE id=?',
        ).run(nowIso(), emotionalWeight, existing.id)
      }
      return `reinforced:${existing.id}`
    }

    const itemId = createHash('md5').update(`${hash}${Date.now()}`).digest('hex').slice(0, 12)
    this.db.prepare(
      `INSERT INTO memory_items
         (id, memory_type, summary, content_hash, embedding, emotional_weight,
          extra_json, source_ref, happened_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      itemId,
      memoryType,
      summary,
      hash,
      embedding === undefined ? null : JSON.stringify(embedding),
      emotionalWeight,
      options.extra && Object.keys(options.extra).length > 0 ? JSON.stringify(options.extra) : null,
      options.sourceRef ?? null,
      options.happenedAt ?? null,
      nowIso(),
      nowIso(),
    )
    return `new:${itemId}`
  }

  /** 原子写入 consolidation event：同一 source_ref 最多写一次。 */
  upsertConsolidationEvent(options: {
    sourceRef: string
    summary: string
    embedding?: readonly number[]
    extra?: Readonly<Record<string, unknown>>
    happenedAt?: string
    emotionalWeight?: number
  }): string {
    const sourceRef = (options.sourceRef ?? '').trim()
    const text = (options.summary ?? '').trim()
    if (!sourceRef || !text) return 'skipped:empty'
    const emotionalWeight = coerceEmotionalWeight(options.emotionalWeight)

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const already = this.db.prepare(
        'SELECT item_id FROM consolidation_events WHERE source_ref=?',
      ).get(sourceRef) as { item_id: string | null } | undefined
      if (already) {
        this.db.exec('COMMIT')
        return `skipped:${already.item_id || sourceRef}`
      }

      const hash = contentHash(text, 'event')
      const existing = this.db.prepare(
        'SELECT id, status FROM memory_items WHERE content_hash=? AND memory_type=?',
      ).get(hash, 'event') as { id: string; status: string } | undefined

      let itemId: string
      let result: string
      if (existing) {
        itemId = existing.id
        if (existing.status === 'superseded') {
          this.db.prepare(
            "UPDATE memory_items SET status='active', reinforcement=reinforcement+1, updated_at=?, emotional_weight=MAX(emotional_weight, ?), happened_at=COALESCE(NULLIF(happened_at, ''), ?) WHERE id=?",
          ).run(nowIso(), emotionalWeight, options.happenedAt ?? null, itemId)
        } else {
          this.db.prepare(
            "UPDATE memory_items SET reinforcement=reinforcement+1, updated_at=?, emotional_weight=MAX(emotional_weight, ?), happened_at=COALESCE(NULLIF(happened_at, ''), ?) WHERE id=?",
          ).run(nowIso(), emotionalWeight, options.happenedAt ?? null, itemId)
        }
        result = `reinforced:${itemId}`
      } else {
        itemId = createHash('md5').update(`${hash}${Date.now()}`).digest('hex').slice(0, 12)
        this.db.prepare(
          `INSERT INTO memory_items
             (id, memory_type, summary, content_hash, embedding, emotional_weight,
              extra_json, source_ref, happened_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          itemId,
          'event',
          text,
          hash,
          options.embedding === undefined ? null : JSON.stringify(options.embedding),
          emotionalWeight,
          options.extra && Object.keys(options.extra).length > 0 ? JSON.stringify(options.extra) : null,
          sourceRef,
          options.happenedAt ?? null,
          nowIso(),
          nowIso(),
        )
        result = `new:${itemId}`
      }

      this.db.prepare(
        'INSERT INTO consolidation_events(source_ref, item_id, created_at) VALUES (?, ?, ?)',
      ).run(sourceRef, itemId, nowIso())
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* ignore */ }
      throw error
    }
  }

  hasConsolidationSourceRef(sourceRef: string): boolean {
    return this.db.prepare(
      'SELECT 1 FROM consolidation_events WHERE source_ref=? LIMIT 1',
    ).get((sourceRef ?? '').trim()) !== undefined
  }

  hasCompletedCompaction(sourceRef: string): boolean {
    return this.db.prepare(
      'SELECT 1 FROM completed_compactions WHERE source_ref=? LIMIT 1',
    ).get((sourceRef ?? '').trim()) !== undefined
  }

  markCompactionCompleted(sourceRef: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO completed_compactions(source_ref, completed_at) VALUES (?, ?)',
    ).run((sourceRef ?? '').trim(), nowIso())
  }

  hasConsolidationLongTermRef(sourceRef: string): boolean {
    return this.db.prepare(
      'SELECT 1 FROM consolidation_long_term_refs WHERE source_ref=? LIMIT 1',
    ).get((sourceRef ?? '').trim()) !== undefined
  }

  markConsolidationLongTermRef(sourceRef: string, itemId?: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO consolidation_long_term_refs(source_ref, item_id, created_at) VALUES (?, ?, ?)',
    ).run((sourceRef ?? '').trim(), itemId ?? null, nowIso())
  }

  markSuperseded(itemId: string): void {
    this.db.prepare(
      "UPDATE memory_items SET status='superseded', updated_at=? WHERE id=?",
    ).run(nowIso(), itemId)
  }

  markSupersededBatch(ids: readonly string[]): void {
    if (ids.length === 0) return
    const now = nowIso()
    const stmt = this.db.prepare(
      "UPDATE memory_items SET status='superseded', updated_at=? WHERE id=?",
    )
    for (const itemId of ids) stmt.run(now, itemId)
  }

  reinforceItemsBatch(ids: readonly string[], emotionalWeight = 0): void {
    if (ids.length === 0) return
    const now = nowIso()
    const weight = coerceEmotionalWeight(emotionalWeight)
    const stmt = this.db.prepare(
      'UPDATE memory_items SET reinforcement=reinforcement+1, updated_at=?, emotional_weight=MAX(emotional_weight, ?) WHERE id=?',
    )
    for (const itemId of ids) stmt.run(now, weight, itemId)
  }

  getItemsByIds(ids: readonly string[]): Readonly<Record<string, unknown>>[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT id, memory_type, summary, extra_json, source_ref, happened_at,
              status, created_at, updated_at, emotional_weight
       FROM memory_items WHERE id IN (${placeholders})`,
    ).all(...ids) as Array<Record<string, unknown>>
    const byId = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      const id = String(row.id)
      byId.set(id, {
        id,
        memory_type: String(row.memory_type),
        summary: String(row.summary),
        extra_json: jsonObject(row.extra_json),
        source_ref: row.source_ref === null ? undefined : String(row.source_ref),
        happened_at: row.happened_at === null ? undefined : String(row.happened_at),
        status: String(row.status),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        emotional_weight: coerceInt(row.emotional_weight),
      })
    }
    return ids.flatMap(itemId => {
      const item = byId.get(itemId)
      return item === undefined ? [] : [item]
    })
  }

  recordReplacements(options: {
    oldItems: readonly Readonly<Record<string, unknown>>[]
    newItem: Readonly<Record<string, unknown>>
    sourceRef?: string
    relationType?: string
  }): number {
    const { oldItems, newItem } = options
    if (oldItems.length === 0 || !newItem.id) return 0
    const now = nowIso()
    const relationType = options.relationType ?? 'supersede'
    const stmt = this.db.prepare(
      `INSERT INTO memory_replacements
         (old_item_id, old_memory_type, old_summary, old_source_ref, old_happened_at,
          old_extra_json, new_item_id, new_memory_type, new_summary, new_source_ref,
          new_happened_at, new_extra_json, relation_type, source_ref, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    let count = 0
    for (const oldItem of oldItems) {
      if (!oldItem.id) continue
      stmt.run(
        String(oldItem.id),
        String(oldItem.memory_type ?? ''),
        String(oldItem.summary ?? ''),
        oldItem.source_ref === undefined || oldItem.source_ref === null ? null : String(oldItem.source_ref),
        oldItem.happened_at === undefined || oldItem.happened_at === null ? null : String(oldItem.happened_at),
        JSON.stringify(oldItem.extra_json ?? {}),
        String(newItem.id),
        String(newItem.memory_type ?? ''),
        String(newItem.summary ?? ''),
        newItem.source_ref === undefined || newItem.source_ref === null ? null : String(newItem.source_ref),
        newItem.happened_at === undefined || newItem.happened_at === null ? null : String(newItem.happened_at),
        JSON.stringify(newItem.extra_json ?? {}),
        relationType,
        options.sourceRef ?? (newItem.source_ref as string | undefined) ?? null,
        now,
      )
      count += 1
    }
    return count
  }

  listReplacements(): Readonly<Record<string, unknown>>[] {
    const rows = this.db.prepare(
      `SELECT old_item_id, old_memory_type, old_summary, old_source_ref, old_happened_at,
              old_extra_json, new_item_id, new_memory_type, new_summary, new_source_ref,
              new_happened_at, new_extra_json, relation_type, source_ref, created_at
       FROM memory_replacements ORDER BY id ASC`,
    ).all() as Array<Record<string, unknown>>
    return rows.map(row => ({
      old_item_id: String(row.old_item_id),
      old_memory_type: String(row.old_memory_type),
      old_summary: String(row.old_summary),
      old_source_ref: row.old_source_ref === null ? undefined : String(row.old_source_ref),
      old_happened_at: row.old_happened_at === null ? undefined : String(row.old_happened_at),
      old_extra_json: jsonObject(row.old_extra_json),
      new_item_id: String(row.new_item_id),
      new_memory_type: String(row.new_memory_type),
      new_summary: String(row.new_summary),
      new_source_ref: row.new_source_ref === null ? undefined : String(row.new_source_ref),
      new_happened_at: row.new_happened_at === null ? undefined : String(row.new_happened_at),
      new_extra_json: jsonObject(row.new_extra_json),
      relation_type: String(row.relation_type),
      source_ref: row.source_ref === null ? undefined : String(row.source_ref),
      created_at: String(row.created_at),
    }))
  }

  /** 原子更新 merge 目标：summary + content_hash + embedding + reinforcement。 */
  mergeItemRaw(options: {
    itemId: string
    newSummary: string
    newHash: string
    newEmbedding: readonly number[]
    newExtra?: Readonly<Record<string, unknown>>
  }): void {
    const { itemId, newSummary, newHash, newEmbedding } = options
    try {
      if (options.newExtra !== undefined) {
        this.db.prepare(
          `UPDATE memory_items
           SET summary=?, content_hash=?, embedding=?, extra_json=?,
               reinforcement=reinforcement+1, updated_at=?
           WHERE id=?`,
        ).run(newSummary, newHash, JSON.stringify(newEmbedding), JSON.stringify(options.newExtra), nowIso(), itemId)
      } else {
        this.db.prepare(
          `UPDATE memory_items
           SET summary=?, content_hash=?, embedding=?,
               reinforcement=reinforcement+1, updated_at=?
           WHERE id=?`,
        ).run(newSummary, newHash, JSON.stringify(newEmbedding), nowIso(), itemId)
      }
    } catch {
      // content_hash 撞上库中已有条目：supersede 旧条目，走 upsert 强化路径
      try { this.db.exec('ROLLBACK') } catch { /* ignore */ }
      const row = this.db.prepare('SELECT memory_type FROM memory_items WHERE id=?').get(itemId) as { memory_type: string } | undefined
      if (row) {
        this.markSuperseded(itemId)
        this.upsertItem(row.memory_type, newSummary, newEmbedding)
      }
    }
  }

  listByType(memoryType: string): Readonly<Record<string, unknown>>[] {
    const rows = this.db.prepare(
      `SELECT id, memory_type, summary, extra_json, happened_at, reinforcement, emotional_weight
       FROM memory_items WHERE memory_type=?`,
    ).all(memoryType) as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: String(row.id),
      memory_type: String(row.memory_type),
      summary: String(row.summary),
      extra_json: jsonObject(row.extra_json),
      happened_at: row.happened_at === null ? undefined : String(row.happened_at),
      reinforcement: coerceInt(row.reinforcement, 1),
      emotional_weight: coerceInt(row.emotional_weight),
    }))
  }

  // -------------------------------------------------------------------------
  // 向量检索（memory2/store/vector.py）
  // -------------------------------------------------------------------------

  /** 读取带 embedding 的行（含内部 _ 前缀字段）。 */
  private getEmbeddingRows(options: {
    includeSuperseded?: boolean | undefined
    memoryTypes?: readonly string[] | undefined
    memoryDomains?: readonly string[] | undefined
    roleId?: string | undefined
    scopeChannel?: string | undefined
    scopeChatId?: string | undefined
    requireScopeMatch?: boolean | undefined
    timeStartMs?: number | undefined
    timeEndMs?: number | undefined
  }): EmbeddingRow[] {
    const where: string[] = ['embedding IS NOT NULL']
    const params: unknown[] = []
    if (!options.includeSuperseded) where.push("status='active'")
    if (options.memoryTypes && options.memoryTypes.length > 0) {
      where.push(`memory_type IN (${options.memoryTypes.map(() => '?').join(',')})`)
      params.push(...options.memoryTypes)
    }
    if (options.memoryDomains && options.memoryDomains.length > 0) {
      where.push(`COALESCE(TRIM(json_extract(extra_json, '$.memory_domain')), '') IN (${options.memoryDomains.map(() => '?').join(',')})`)
      params.push(...options.memoryDomains.map(domain => domain.trim()))
    }
    if (options.roleId) {
      where.push(roleFilter())
      params.push(options.roleId.trim())
    }
    if (options.requireScopeMatch) {
      where.push("COALESCE(TRIM(json_extract(extra_json, '$.scope_channel')), '') = ?")
      where.push("COALESCE(TRIM(json_extract(extra_json, '$.scope_chat_id')), '') = ?")
      params.push((options.scopeChannel ?? '').trim(), (options.scopeChatId ?? '').trim())
    }
    // 时间过滤只在该 filter 显式给出时应用，避免误滤无 happened_at 的记录
    if (options.timeStartMs !== undefined || options.timeEndMs !== undefined) {
      const { clauses, clauseParams } = this.timePrefilterClauses(options.timeStartMs, options.timeEndMs)
      where.push(...clauses)
      params.push(...clauseParams)
    }

    const rows = this.db.prepare(
      `SELECT id, memory_type, summary, embedding, extra_json, happened_at,
              reinforcement, updated_at, source_ref, emotional_weight
       FROM memory_items WHERE ${where.join(' AND ')}`,
    ).all(...params) as Array<Record<string, unknown>>

    const result: EmbeddingRow[] = []
    const hasTimeFilter = options.timeStartMs !== undefined || options.timeEndMs !== undefined
    for (const row of rows) {
      const happenedAt = row.happened_at === null ? undefined : String(row.happened_at)
      if (hasTimeFilter && !memoryTimeInRange(happenedAt, options.timeStartMs, options.timeEndMs)) continue
      const embedding = jsonEmbedding(row.embedding)
      if (embedding === undefined) continue
      const extra = jsonObject(row.extra_json)
      extra._reinforcement = coerceInt(row.reinforcement, 1)
      extra._updated_at = row.updated_at === null ? '' : String(row.updated_at)
      extra._emotional_weight = coerceEmotionalWeight(row.emotional_weight)
      result.push({
        id: String(row.id),
        memoryType: String(row.memory_type),
        summary: String(row.summary),
        embedding,
        extra,
        happenedAt,
        sourceRef: row.source_ref === null ? undefined : String(row.source_ref),
      })
    }
    return result
  }

  private timePrefilterClauses(timeStartMs?: number | undefined, timeEndMs?: number | undefined): { clauses: string[]; clauseParams: unknown[] } {
    const clauses = ["happened_at IS NOT NULL", "TRIM(happened_at) != ''"]
    const params: unknown[] = []
    if (timeStartMs !== undefined) {
      clauses.push('happened_at >= ?')
      params.push(localNaiveIso(timeStartMs - TIME_FILTER_MARGIN_DAYS * 86_400_000))
    }
    if (timeEndMs !== undefined) {
      clauses.push('happened_at < ?')
      params.push(localNaiveIso(timeEndMs + TIME_FILTER_MARGIN_DAYS * 86_400_000))
    }
    return { clauses, clauseParams: params }
  }

  vectorSearch(queryVec: readonly number[], options: VectorSearchOptions = {}): StoreHit[] {
    const timeStartMs = options.timeStart === undefined ? undefined : parseMemoryTime(options.timeStart)
    const timeEndMs = options.timeEnd === undefined ? undefined : parseMemoryTime(options.timeEnd)
    const rows = this.getEmbeddingRows({
      includeSuperseded: options.includeSuperseded,
      memoryTypes: options.memoryTypes,
      memoryDomains: options.memoryDomains,
      roleId: options.roleId,
      scopeChannel: options.scopeChannel,
      scopeChatId: options.scopeChatId,
      requireScopeMatch: options.requireScopeMatch,
      timeStartMs,
      timeEndMs,
    })
    return this.scoreEmbeddingRows(queryVec, rows, {
      topK: options.topK ?? 8,
      scoreThreshold: options.scoreThreshold ?? 0,
      hotnessAlpha: options.hotnessAlpha ?? 0,
      hotnessHalfLifeDays: options.hotnessHalfLifeDays ?? 14,
    })
  }

  vectorSearchBatch(queryVecs: readonly (readonly number[])[], options: VectorSearchOptions = {}): StoreHit[][] {
    if (queryVecs.length === 0) return []
    return queryVecs.map(queryVec => this.vectorSearch(queryVec, options))
  }

  private scoreEmbeddingRows(
    queryVec: readonly number[],
    rows: EmbeddingRow[],
    options: { topK: number; scoreThreshold: number; hotnessAlpha: number; hotnessHalfLifeDays: number },
  ): StoreHit[] {
    const now = Date.now()
    const scored: StoreHit[] = []
    for (const row of rows) {
      const semantic = cosineSimilarity(queryVec, row.embedding ?? [])
      if (semantic < options.scoreThreshold) continue
      let hotness = 0
      if (options.hotnessAlpha > 0) {
        const updatedAt = String(row.extra._updated_at ?? '')
        if (updatedAt) {
          hotness = hotnessScore(
            coerceInt(row.extra._reinforcement, 1),
            updatedAt,
            now,
            options.hotnessHalfLifeDays,
            coerceEmotionalWeight(row.extra._emotional_weight),
          )
        }
      }
      const final = (1 - options.hotnessAlpha) * semantic + options.hotnessAlpha * hotness
      scored.push({
        id: row.id,
        memoryType: row.memoryType,
        memoryDomain: String(row.extra.memory_domain ?? '') || undefined,
        summary: row.summary,
        extraJson: row.extra,
        happenedAt: row.happenedAt,
        sourceRef: row.sourceRef,
        score: Math.round(final * 10_000) / 10_000,
        scoreDebug: {
          semantic: Math.round(semantic * 10_000) / 10_000,
          hotness: Math.round(hotness * 10_000) / 10_000,
          final: Math.round(final * 10_000) / 10_000,
        },
      })
    }
    scored.sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    return scored.slice(0, options.topK)
  }

  // -------------------------------------------------------------------------
  // 时间与关键词检索（memory2/store/temporal.py）
  // -------------------------------------------------------------------------

  listEventsByTimeRange(timeStart: string, timeEnd: string, options: {
    limit?: number | undefined
    memoryDomains?: readonly string[] | undefined
    roleId?: string | undefined
    scopeChannel?: string | undefined
    scopeChatId?: string | undefined
    requireScopeMatch?: boolean | undefined
  } = {}): Readonly<Record<string, unknown>>[] {
    const startMs = parseMemoryTime(timeStart)
    const endMs = parseMemoryTime(timeEnd)
    if (startMs === undefined || endMs === undefined) return []
    const { clauses, clauseParams } = this.timePrefilterClauses(startMs, endMs)
    const where = ["memory_type='event'", "status='active'", ...clauses]
    const params: unknown[] = [...clauseParams]
    if (options.memoryDomains && options.memoryDomains.length > 0) {
      where.push(`COALESCE(TRIM(json_extract(extra_json, '$.memory_domain')), '') IN (${options.memoryDomains.map(() => '?').join(',')})`)
      params.push(...options.memoryDomains.map(domain => domain.trim()))
    }
    if (options.roleId) {
      where.push(roleFilter())
      params.push(options.roleId.trim())
    }
    if (options.requireScopeMatch) {
      where.push("COALESCE(TRIM(json_extract(extra_json, '$.scope_channel')), '') = ?")
      where.push("COALESCE(TRIM(json_extract(extra_json, '$.scope_chat_id')), '') = ?")
      params.push((options.scopeChannel ?? '').trim(), (options.scopeChatId ?? '').trim())
    }
    const rows = this.db.prepare(
      `SELECT id, memory_type, summary, source_ref, happened_at
       FROM memory_items WHERE ${where.join(' AND ')}`,
    ).all(...params) as Array<Record<string, unknown>>

    const hits: Array<{ ms: number; item: Record<string, unknown> }> = []
    for (const row of rows) {
      const happenedAt = row.happened_at === null ? undefined : String(row.happened_at)
      const ms = parseMemoryTime(happenedAt)
      if (ms === undefined || ms < startMs || ms >= endMs) continue
      hits.push({
        ms,
        item: {
          id: String(row.id),
          memory_type: String(row.memory_type),
          summary: String(row.summary),
          source_ref: row.source_ref === null ? undefined : String(row.source_ref),
          happened_at: happenedAt ?? '',
          score: 1,
        },
      })
    }
    const maxItems = Math.max(1, Math.min(options.limit ?? 200, 200))
    hits.sort((left, right) => right.ms - left.ms)
    const selected = hits.slice(0, maxItems).sort((left, right) => left.ms - right.ms)
    return selected.map(entry => entry.item)
  }

  findSimilarRecentEvents(
    embedding: readonly number[],
    options: { daysBack?: number; threshold?: number; topK?: number } = {},
  ): string[] {
    const daysBack = Math.max(1, Math.trunc(options.daysBack ?? 7))
    const threshold = options.threshold ?? 0.92
    const cutoff = new Date(Date.now() - daysBack * 86_400_000).toISOString()
    const rows = this.db.prepare(
      `SELECT id, embedding FROM memory_items
       WHERE memory_type='event' AND status='active'
         AND embedding IS NOT NULL AND created_at >= ?`,
    ).all(cutoff) as Array<{ id: string; embedding: string | null }>
    const scored: Array<{ id: string; score: number }> = []
    for (const row of rows) {
      const emb = jsonEmbedding(row.embedding)
      if (emb === undefined) continue
      const score = cosineSimilarity(embedding, emb)
      if (score >= threshold) scored.push({ id: row.id, score })
    }
    scored.sort((left, right) => right.score - left.score)
    return scored.slice(0, Math.max(1, Math.trunc(options.topK ?? 3))).map(entry => entry.id)
  }

  deleteBySourceRef(sourceRef: string): number {
    const result = this.db.prepare('DELETE FROM memory_items WHERE source_ref=?').run(sourceRef)
    return Number(result.changes ?? 0)
  }

  hasItemBySourceRef(sourceRef: string, memoryType?: string): boolean {
    if (memoryType) {
      return this.db.prepare(
        'SELECT 1 FROM memory_items WHERE source_ref=? AND memory_type=? LIMIT 1',
      ).get(sourceRef, memoryType) !== undefined
    }
    return this.db.prepare(
      'SELECT 1 FROM memory_items WHERE source_ref=? LIMIT 1',
    ).get(sourceRef) !== undefined
  }

  keywordMatchProcedures(actionTokens: readonly string[]): Readonly<Record<string, unknown>>[] {
    if (actionTokens.length === 0) return []
    const tokenSet = new Set(actionTokens.map(token => String(token).toLowerCase()).filter(Boolean))
    const actionText = actionTokens.join(' ').toLowerCase()
    const rows = this.db.prepare(
      "SELECT id, summary, extra_json FROM memory_items WHERE memory_type='procedure' AND status='active' AND extra_json IS NOT NULL",
    ).all() as Array<{ id: string; summary: string; extra_json: string | null }>

    const matched: Record<string, unknown>[] = []
    for (const row of rows) {
      const extra = jsonObject(row.extra_json)
      const tags = extra.trigger_tags
      if (typeof tags !== 'object' || tags === null) continue
      const tagRecord = tags as Record<string, unknown>
      if (tagRecord.scope !== 'tool_triggered') continue
      const keywords = (tagRecord.keywords as unknown[] | undefined ?? [])
        .filter(keyword => typeof keyword === 'string' && keyword.length >= 3)
        .map(keyword => String(keyword))
      let hit: boolean
      if (keywords.length > 0) {
        hit = keywords.some(keyword => actionText.includes(keyword.toLowerCase()))
      } else {
        const procTools = (tagRecord.tools as unknown[] | undefined ?? []).map(tool => String(tool))
        if (procTools.length > 4) continue
        const procSkills = (tagRecord.skills as unknown[] | undefined ?? []).map(skill => String(skill))
        const tagTokens = new Set([...procTools, ...procSkills].map(token => token.toLowerCase()))
        hit = [...tokenSet].some(token => tagTokens.has(token))
      }
      if (hit) {
        matched.push({
          id: row.id,
          memory_type: 'procedure',
          summary: row.summary,
          extra_json: extra,
          intercept: Boolean(tagRecord.intercept),
          score: 1,
        })
      }
    }
    return matched
  }

  /** OR-LIKE 关键词检索，按命中词数降序，携带 keyword_score 供 RRF。 */
  keywordSearchSummary(terms: readonly string[], options: KeywordSearchOptions = {}): StoreHit[] {
    const cleanTerms = terms.filter(term => term && term.length >= 2)
    if (cleanTerms.length === 0) return []
    const limit = Math.max(1, options.limit ?? 20)

    const typeFilter = options.memoryTypes && options.memoryTypes.length > 0
      ? ` AND memory_type IN (${options.memoryTypes.map(() => '?').join(',')})`
      : ''
    const typeParams = options.memoryTypes && options.memoryTypes.length > 0 ? [...options.memoryTypes] : []

    const domainFilter = options.memoryDomains && options.memoryDomains.length > 0
      ? ` AND COALESCE(TRIM(json_extract(extra_json, '$.memory_domain')), '') IN (${options.memoryDomains.map(() => '?').join(',')})`
      : ''
    const domainParams = options.memoryDomains && options.memoryDomains.length > 0
      ? options.memoryDomains.map(domain => domain.trim())
      : []

    const roleFilterSql = options.roleId ? ` AND ${roleFilter()}` : ''
    const roleParams = options.roleId ? [options.roleId.trim()] : []

    const scopeFilter = options.requireScopeMatch
      ? " AND COALESCE(TRIM(json_extract(extra_json, '$.scope_channel')), '') = ? AND COALESCE(TRIM(json_extract(extra_json, '$.scope_chat_id')), '') = ?"
      : ''
    const scopeParams = options.requireScopeMatch
      ? [(options.scopeChannel ?? '').trim(), (options.scopeChatId ?? '').trim()]
      : []

    const timeStartMs = options.timeStart === undefined ? undefined : parseMemoryTime(options.timeStart)
    const timeEndMs = options.timeEnd === undefined ? undefined : parseMemoryTime(options.timeEnd)
    const hasTimeFilter = timeStartMs !== undefined || timeEndMs !== undefined
    const { clauses, clauseParams } = this.timePrefilterClauses(timeStartMs, timeEndMs)
    const timeFilter = hasTimeFilter ? ` AND ${clauses.join(' AND ')}` : ''

    const orConditions = cleanTerms.map(() => 'summary LIKE ?').join(' OR ')
    const scoreExpr = cleanTerms.map(() => '(CASE WHEN summary LIKE ? THEN 1 ELSE 0 END)').join(' + ')
    const likeVals = cleanTerms.map(term => `%${term}%`)
    const batchSize = hasTimeFilter ? Math.max(limit, TIME_FILTER_KEYWORD_CANDIDATE_LIMIT) : limit

    const sql = `SELECT id, memory_type, summary, extra_json, source_ref, happened_at, created_at,
                        reinforcement, (${scoreExpr}) AS kw_score
                 FROM memory_items
                 WHERE status='active' AND (${orConditions})${typeFilter}${domainFilter}${roleFilterSql}${scopeFilter}${timeFilter}
                 ORDER BY kw_score DESC, reinforcement DESC, id ASC
                 LIMIT ? OFFSET ?`

    const results: StoreHit[] = []
    let offset = 0
    for (;;) {
      const params = [
        ...likeVals, ...likeVals,
        ...typeParams, ...domainParams, ...roleParams, ...scopeParams,
        ...clauseParams,
        batchSize, offset,
      ]
      const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
      if (rows.length === 0) break
      for (const row of rows) {
        const happenedAt = row.happened_at === null ? undefined : String(row.happened_at)
        if (hasTimeFilter && !memoryTimeInRange(happenedAt, timeStartMs, timeEndMs)) continue
        const extra = jsonObject(row.extra_json)
        results.push({
          id: String(row.id),
          memoryType: String(row.memory_type),
          memoryDomain: String(extra.memory_domain ?? '') || undefined,
          summary: String(row.summary),
          sourceRef: row.source_ref === null ? undefined : String(row.source_ref),
          happenedAt: happenedAt ?? String(row.created_at ?? ''),
          keywordScore: coerceFloat(row.kw_score) / cleanTerms.length,
          extraJson: extra,
        })
        if (results.length >= limit) return results
      }
      if (!hasTimeFilter || rows.length < batchSize) break
      offset += batchSize
    }
    return results
  }

  // -------------------------------------------------------------------------
  // 管理（memory2/store/admin.py）
  // -------------------------------------------------------------------------

  invalidateRoleMemories(roleId: string): number {
    const clean = String(roleId ?? '').trim()
    if (!clean) throw new Error('role_id required for memory invalidation')
    const result = this.db.prepare(
      `UPDATE memory_items SET status='superseded', updated_at=?
       WHERE status!='superseded' AND ${roleFilter()}`,
    ).run(nowIso(), clean)
    return Number(result.changes ?? 0)
  }

  listItemsForAdmin(options: {
    q?: string | undefined
    memoryType?: string | undefined
    memoryDomain?: string | undefined
    status?: string | undefined
    sourceRef?: string | undefined
    roleId?: string | undefined
    scopeChannel?: string | undefined
    scopeChatId?: string | undefined
    hasEmbedding?: boolean | undefined
    page?: number | undefined
    pageSize?: number | undefined
    sortBy?: string | undefined
    sortOrder?: 'asc' | 'desc' | undefined
  } = {}): { items: Readonly<Record<string, unknown>>[]; total: number } {
    const safeSortBy = ['updated_at', 'created_at', 'happened_at', 'reinforcement', 'emotional_weight', 'memory_type'].includes(options.sortBy ?? '')
      ? options.sortBy!
      : 'created_at'
    const safeSortOrder = options.sortOrder === 'asc' ? 'asc' : 'desc'
    const safePage = Math.max(1, options.page ?? 1)
    const safePageSize = Math.max(1, Math.min(options.pageSize ?? 50, 200))
    const offset = (safePage - 1) * safePageSize

    const where: string[] = ['1=1']
    const params: unknown[] = []
    if (options.q) {
      where.push("(id LIKE ? OR summary LIKE ? OR COALESCE(source_ref, '') LIKE ?)")
      const like = `%${options.q}%`
      params.push(like, like, like)
    }
    if (options.memoryType) {
      where.push('memory_type = ?')
      params.push(options.memoryType)
    }
    if (options.memoryDomain) {
      where.push(domainFilter())
      params.push(options.memoryDomain.trim())
    }
    if (options.status) {
      where.push('status = ?')
      params.push(options.status)
    }
    if (options.sourceRef) {
      where.push("COALESCE(source_ref, '') LIKE ?")
      params.push(`%${options.sourceRef}%`)
    }
    if (options.roleId) {
      where.push(roleFilter())
      params.push(options.roleId.trim())
    }
    if (options.scopeChannel) {
      where.push("COALESCE(TRIM(json_extract(extra_json, '$.scope_channel')), '') = ?")
      params.push(options.scopeChannel.trim())
    }
    if (options.scopeChatId) {
      where.push("COALESCE(TRIM(json_extract(extra_json, '$.scope_chat_id')), '') = ?")
      params.push(options.scopeChatId.trim())
    }
    if (options.hasEmbedding === true) where.push('embedding IS NOT NULL')
    else if (options.hasEmbedding === false) where.push('embedding IS NULL')

    const whereSql = where.join(' AND ')
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM memory_items WHERE ${whereSql}`).get(...params) as { count: number }).count)
    const rows = this.db.prepare(
      `SELECT id, memory_type, summary, source_ref, happened_at, status,
              created_at, updated_at, reinforcement, emotional_weight,
              extra_json, embedding IS NOT NULL AS has_embedding
       FROM memory_items
       WHERE ${whereSql}
       ORDER BY ${safeSortBy} ${safeSortOrder}, id ASC
       LIMIT ? OFFSET ?`,
    ).all(...params, safePageSize, offset) as Array<Record<string, unknown>>

    const items = rows.map(row => {
      const extra = jsonObject(row.extra_json)
      return {
        id: String(row.id),
        memory_type: String(row.memory_type),
        memory_domain: String(extra.memory_domain ?? '') || '',
        summary: String(row.summary),
        extra_json: extra,
        source_ref: row.source_ref === null ? undefined : String(row.source_ref),
        happened_at: row.happened_at === null ? undefined : String(row.happened_at),
        status: String(row.status),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
        reinforcement: coerceInt(row.reinforcement),
        emotional_weight: coerceInt(row.emotional_weight),
        has_embedding: Boolean(row.has_embedding),
        scope_channel: extra.scope_channel ?? '',
        scope_chat_id: extra.scope_chat_id ?? '',
      }
    })
    return { items, total }
  }

  getItemForAdmin(itemId: string, includeEmbedding = false): Readonly<Record<string, unknown>> | undefined {
    const row = this.db.prepare(
      `SELECT id, memory_type, summary, content_hash, embedding, reinforcement,
              emotional_weight, extra_json, source_ref, happened_at, status, created_at, updated_at
       FROM memory_items WHERE id=?`,
    ).get(itemId) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    const embedding = jsonEmbedding(row.embedding)
    const extra = jsonObject(row.extra_json)
    return {
      id: String(row.id),
      memory_type: String(row.memory_type),
      memory_domain: String(extra.memory_domain ?? '') || '',
      summary: String(row.summary),
      content_hash: String(row.content_hash),
      reinforcement: coerceInt(row.reinforcement),
      emotional_weight: coerceInt(row.emotional_weight),
      extra_json: extra,
      role_id: String(extra.role_id ?? '') || '',
      source_ref: row.source_ref === null ? undefined : String(row.source_ref),
      happened_at: row.happened_at === null ? undefined : String(row.happened_at),
      status: String(row.status),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      has_embedding: embedding !== undefined,
      embedding_dim: embedding?.length ?? 0,
      embedding: includeEmbedding ? embedding : undefined,
    }
  }

  updateItemForAdmin(itemId: string, patch: {
    status?: 'active' | 'superseded' | undefined
    extraJson?: Readonly<Record<string, unknown>> | undefined
    sourceRef?: string | undefined
    happenedAt?: string | undefined
    emotionalWeight?: number | undefined
  }): Readonly<Record<string, unknown>> | undefined {
    const updates: string[] = []
    const params: unknown[] = []
    if (patch.status !== undefined) {
      if (patch.status !== 'active' && patch.status !== 'superseded') {
        throw new Error('status 仅支持 active 或 superseded')
      }
      updates.push('status=?')
      params.push(patch.status)
    }
    if (patch.extraJson !== undefined) {
      updates.push('extra_json=?')
      params.push(JSON.stringify(patch.extraJson))
    }
    if (patch.sourceRef !== undefined) {
      updates.push('source_ref=?')
      params.push(patch.sourceRef)
    }
    if (patch.happenedAt !== undefined) {
      updates.push('happened_at=?')
      params.push(patch.happenedAt)
    }
    if (patch.emotionalWeight !== undefined) {
      updates.push('emotional_weight=?')
      params.push(coerceEmotionalWeight(patch.emotionalWeight))
    }
    if (updates.length === 0) return this.getItemForAdmin(itemId)
    updates.push('updated_at=?')
    params.push(nowIso(), itemId)
    const result = this.db.prepare(
      `UPDATE memory_items SET ${updates.join(', ')} WHERE id=?`,
    ).run(...params)
    if (Number(result.changes ?? 0) <= 0) return undefined
    return this.getItemForAdmin(itemId)
  }

  deleteItem(itemId: string): boolean {
    const result = this.db.prepare('DELETE FROM memory_items WHERE id=?').run(itemId)
    return Number(result.changes ?? 0) > 0
  }

  deleteItemsBatch(ids: readonly string[]): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    const result = this.db.prepare(
      `DELETE FROM memory_items WHERE id IN (${placeholders})`,
    ).run(...ids)
    return Number(result.changes ?? 0)
  }

  findSimilarItemsForAdmin(itemId: string, options: {
    topK?: number | undefined
    memoryType?: string | undefined
    scoreThreshold?: number | undefined
    includeSuperseded?: boolean | undefined
  } = {}): Readonly<Record<string, unknown>>[] {
    const base = this.getItemForAdmin(itemId, true)
    if (base === undefined) throw new Error(`unknown memory item '${itemId}'`)
    const embedding = base.embedding
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error('memory 没有 embedding')
    }
    const topK = Math.max(1, options.topK ?? 8)
    const results = this.vectorSearch(embedding, {
      topK: topK + 1,
      memoryTypes: options.memoryType ? [options.memoryType] : undefined,
      scoreThreshold: options.scoreThreshold ?? 0,
      includeSuperseded: options.includeSuperseded,
    })
    const filtered = results.filter(item => item.id !== itemId)
    return filtered.slice(0, topK)
  }
}

/** 记忆库默认路径（供 service 装配）。 */
export function resolveMemoryDbPath(memoryRoot: string, roleId: string): string {
  const id = roleId.trim()
  if (!id || id.includes('..') || /[\\/]/.test(id)) throw new Error(`shiori-role: invalid role id '${roleId}'`)
  return join(memoryRoot, 'shiori-plugin', 'role', id, 'memory', 'memory2.db')
}
