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

/** Domain storing the active role selected for each workspace. */
export const shioriRoleDomainSpec = defineDomain({
  name: 'shiori_role',
  version: 1,
  tables: {
    workspace_roles: domainTable<string, WorkspaceRoleRecord>(workspaceRoleRecord),
    session_roles: domainTable<SessionId, SessionRoleRecord>(sessionRoleRecord),
  },
})
