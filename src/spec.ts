import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { z } from 'zod'

const imageAttachmentRef: z.ZodType<ImageAttachmentRef> = z.object({
  attachmentId: z.string(),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string().optional(),
}).transform(value => value as ImageAttachmentRef)

/** Durable editable role definition. */
export const roleRecord = z.object({
  name: z.string(),
  introduction: z.string(),
  prompt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().optional(),
})

/** Inferred durable role definition. */
export type RoleRecord = z.infer<typeof roleRecord>

/** One-time seed-import marker. */
export const roleCatalogRecord = z.object({ initializedAt: z.string() })

/** Inferred role catalog marker. */
export type RoleCatalogRecord = z.infer<typeof roleCatalogRecord>

/** Durable role image reference; bytes are owned by the attachment service. */
export const roleAssetRecord = z.object({
  roleId: z.string(),
  purpose: z.enum(['avatar', 'portrait', 'gallery', 'theme_background']),
  attachment: imageAttachmentRef,
  createdAt: z.string(),
})

/** Inferred durable role image record. */
export type RoleAssetRecord = z.infer<typeof roleAssetRecord>

/** Durable workspace-to-role selection record. */
export const workspaceRoleRecord = z.object({
  roleId: z.string(),
  updatedAt: z.string(),
})

/** Inferred durable workspace role record. */
export type WorkspaceRoleRecord = z.infer<typeof workspaceRoleRecord>

/** Durable role binding for one session. */
export const sessionRoleRecord = z.object({
  roleId: z.string(),
  boundAt: z.string(),
  bindingVersion: z.number().int().positive().default(1),
})

/** Inferred durable session role record. */
export type SessionRoleRecord = z.infer<typeof sessionRoleRecord>

/** Mutable selection for a blank session, consumed at Agent publication. */
export const pendingSessionRoleRecord = z.object({
  roleId: z.string(),
  updatedAt: z.string(),
})

/** Inferred pending session selection. */
export type PendingSessionRoleRecord = z.infer<typeof pendingSessionRoleRecord>

const roleMemoryScope = z.object({
  sessionKey: z.string().optional(),
  channel: z.string().optional(),
  chatId: z.string().optional(),
})

const roleMemoryEvidence = z.object({
  kind: z.enum(['message', 'message_range', 'turn', 'external']),
  refs: z.array(z.string()),
  sourceRef: z.string().optional(),
})

/** Durable memory entry owned by one role. Defaults keep version-1 rows readable. */
export const roleMemoryRecord = z.object({
  roleId: z.string(),
  /** Canonical Shiori memory_items fields. Legacy fields remain readable. */
  summary: z.string().optional(),
  contentHash: z.string().default(''),
  embedding: z.array(z.number()).optional(),
  extra: z.record(z.string(), z.string()).default({}),
  content: z.string().default(''),
  kind: z.string().default('fact'),
  memoryType: z.string().optional(),
  domain: z.enum(['role_self', 'relationship', 'shared']).default('role_self'),
  scope: roleMemoryScope.default({}),
  sourceRef: z.string().default(''),
  happenedAt: z.string().default(''),
  evidence: z.array(roleMemoryEvidence).default([]),
  status: z.enum(['active', 'superseded']).default('active'),
  reinforcementCount: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** Inferred durable role memory record. */
export type StoredRoleMemoryRecord = z.infer<typeof roleMemoryRecord>

const memoryEndpointConfig = z.object({
  endpoint: z.string(),
  apiKey: z.string().optional(),
  model: z.string(),
})

/** Runtime-editable memory configuration (embedding / extraction endpoints). */
export const memoryConfigRecord = z.object({
  embedding: memoryEndpointConfig.optional(),
  extraction: memoryEndpointConfig.optional(),
  dbPath: z.string().optional(),
  updatedAt: z.string(),
})

/** Inferred durable memory configuration record. */
export type MemoryConfigRecord = z.infer<typeof memoryConfigRecord>

/** Domain storing the active role selected for each workspace. */
export const shioriRoleDomainSpec = defineDomain({
  name: 'shiori_role',
  version: 1,
  tables: {
    workspace_roles: domainTable<string, WorkspaceRoleRecord>(workspaceRoleRecord),
    session_roles: domainTable<SessionId, SessionRoleRecord>(sessionRoleRecord),
    pending_session_roles: domainTable<SessionId, PendingSessionRoleRecord>(pendingSessionRoleRecord),
    roles: domainTable<string, RoleRecord>(roleRecord),
    role_assets: domainTable<string, RoleAssetRecord>(roleAssetRecord),
    catalog: domainTable<string, RoleCatalogRecord>(roleCatalogRecord),
    memories: domainTable<string, StoredRoleMemoryRecord>(roleMemoryRecord),
    memory_config: domainTable<string, MemoryConfigRecord>(memoryConfigRecord),
  },
})
