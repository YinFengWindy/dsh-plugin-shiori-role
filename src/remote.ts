import { z } from 'zod'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceRoleSnapshot } from './types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    shioriRole: {
      snapshot: (workspaceId: string) => Promise<RemoteResult<WorkspaceRoleSnapshot>>
      select: (workspaceId: string, roleId: string) => Promise<RemoteResult<WorkspaceRoleSnapshot>>
    }
  }
}

const snapshotSchema = z.object({
  workspaceId: z.string(),
  roles: z.array(z.object({ id: z.string(), name: z.string() })),
  activeRoleId: z.string().optional(),
})

/** Client Remote descriptor contributed by this plugin. */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: '@deepseek-ai/dsh-plugin-shiori-role',
  descriptors: [
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/snapshot',
      service: 'shioriRole',
      namespace: 'shioriRole',
      method: 'snapshot',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'workspaceId', wire: 'workspaceId', source: 'json', codec: { mode: 'strict', typeSymbol: 'string', schema: z.string() } }],
      result: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-plugin-shiori-role#WorkspaceRoleSnapshot', schema: snapshotSchema },
    },
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/select',
      service: 'shioriRole',
      namespace: 'shioriRole',
      method: 'select',
      implementation: 'selectRemote',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'workspaceId', wire: 'workspaceId', source: 'json', codec: { mode: 'strict', typeSymbol: 'string', schema: z.string() } },
        { name: 'roleId', wire: 'roleId', source: 'json', codec: { mode: 'strict', typeSymbol: 'string', schema: z.string() } },
      ],
      result: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-plugin-shiori-role#WorkspaceRoleSnapshot', schema: snapshotSchema },
    },
  ],
}

export default TYPERT_REMOTE
