/** Native Cordis role plugin for Shiori characters. */

export { apply, inject, name, type Config } from './role-plugin.ts'
import { ShioriRoleService } from './service.ts'

export type { ShioriRoleDefinition, ShioriRoleView, WorkspaceRoleSnapshot } from './types.ts'
export type {
  RoleMemory,
  RoleMemoryDomain,
  RoleMemoryEvidence,
  RoleMemoryMutation,
  RoleMemoryMutationResult,
  RoleMemoryQuery,
  RoleMemoryQueryIntent,
  RoleMemoryQueryResult,
  RoleMemoryScope,
} from './memory-contract.ts'
export { ShioriRoleService } from './service.ts'
export {
  shioriRoleDomainSpec,
  sessionRoleRecord,
  workspaceRoleRecord,
  type SessionRoleRecord,
  type WorkspaceRoleRecord,
  type StoredRoleMemoryRecord,
} from './spec.ts'
export { ShioriMemoryService, applyMemoryTools } from './memory.ts'
export type {
  ExtractedMemory,
  MemoryEmbeddingConfig,
  MemoryExtractionConfig,
} from './memory.ts'
export {
  DefaultMemoryEngine,
  normalizeScope,
} from './memory-engine/engine.ts'
export type {
  ExtractedMemory as EngineExtractedMemory,
} from './memory-engine/engine.ts'
export type {
  MemoryCapability,
  MemoryEngine,
  MemoryEngineDescriptor,
  MemoryIngestRequest,
  MemoryIngestResult,
  MemoryMutation,
  MemoryMutationResult,
  MemoryQuery,
  MemoryQueryResult,
  MemoryRecord,
  MemoryScope,
  MemoryToolProfile,
  MemoryToolSpec,
  StoreHit,
} from './memory-engine/contracts.ts'
export { ShioriMemoryStore, resolveMemoryDbPath, contentHash, hotnessScore } from './memory-engine/store.ts'
export { ChatClient, Embedder, cosineSimilarity } from './memory-engine/llm.ts'
export { Retriever, extractTerms, rrfMerge } from './memory-engine/retriever.ts'
export {
  DEFAULT_MEMORY_CONFIG,
  resolveMemoryConfig,
  type DefaultMemoryConfig,
  type RetrievalConfig,
} from './memory-engine/config.ts'
export {
  DuplicateRoleError,
  MemoryRoleSelectionStore,
  UnknownRoleError,
  WorkspaceRoleRegistry,
  type RoleSelectionStore,
  type WorkspaceKey,
} from './registry.ts'

export default ShioriRoleService
