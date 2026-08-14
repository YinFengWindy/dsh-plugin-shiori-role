/**
 * default_memory 配置，镜像 `plugins/default_memory/config.py`。
 * 端点配置由插件 Config.memory 提供（OpenAI 兼容 embedding/chat 端点）。
 */

export interface RetrievalThresholdsConfig {
  readonly procedure: number
  readonly preference: number
  readonly event: number
  readonly profile: number
}

export interface RetrievalInjectConfig {
  readonly maxChars: number
  readonly forced: number
  readonly procedurePreference: number
  readonly eventProfile: number
  readonly lineMax: number
}

export interface RetrievalConfig {
  readonly topKHistory: number
  readonly scoreThreshold: number
  readonly relativeDelta: number
  readonly procedureGuardEnabled: boolean
  readonly thresholds: RetrievalThresholdsConfig
  readonly inject: RetrievalInjectConfig
}

export interface DefaultMemoryConfig {
  /** SQLite 数据库路径；留空时用 `<memoryRoot>/shiori-plugin/role/memory2.db`。 */
  readonly dbPath?: string
  readonly retrieval: RetrievalConfig
}

export const DEFAULT_THRESHOLDS: RetrievalThresholdsConfig = {
  procedure: 0.66,
  preference: 0.5,
  event: 0.5,
  profile: 0.5,
}

export const DEFAULT_INJECT: RetrievalInjectConfig = {
  maxChars: 6000,
  forced: 3,
  procedurePreference: 4,
  eventProfile: 4,
  lineMax: 600,
}

export const DEFAULT_MEMORY_CONFIG: DefaultMemoryConfig = {
  retrieval: {
    topKHistory: 8,
    scoreThreshold: 0.45,
    relativeDelta: 0.2,
    procedureGuardEnabled: true,
    thresholds: DEFAULT_THRESHOLDS,
    inject: DEFAULT_INJECT,
  },
}

export function resolveMemoryConfig(partial?: Partial<RetrievalConfig>): RetrievalConfig {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(partial?.thresholds ?? {}) }
  const inject = { ...DEFAULT_INJECT, ...(partial?.inject ?? {}) }
  return {
    topKHistory: partial?.topKHistory ?? DEFAULT_MEMORY_CONFIG.retrieval.topKHistory,
    scoreThreshold: partial?.scoreThreshold ?? DEFAULT_MEMORY_CONFIG.retrieval.scoreThreshold,
    relativeDelta: partial?.relativeDelta ?? DEFAULT_MEMORY_CONFIG.retrieval.relativeDelta,
    procedureGuardEnabled: partial?.procedureGuardEnabled ?? DEFAULT_MEMORY_CONFIG.retrieval.procedureGuardEnabled,
    thresholds,
    inject,
  }
}
