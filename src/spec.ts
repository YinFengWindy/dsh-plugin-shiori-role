import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'

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
})

/** Inferred durable session role record. */
export type SessionRoleRecord = z.infer<typeof sessionRoleRecord>

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
  content: z.string(),
  kind: z.string().default('fact'),
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

/** Domain storing the active role selected for each workspace. */
export const shioriRoleDomainSpec = defineDomain({
  name: 'shiori_role',
  version: 1,
  tables: {
    workspace_roles: domainTable<string, WorkspaceRoleRecord>(workspaceRoleRecord),
    session_roles: domainTable<SessionId, SessionRoleRecord>(sessionRoleRecord),
    memories: domainTable<string, StoredRoleMemoryRecord>(roleMemoryRecord),
  },
})
