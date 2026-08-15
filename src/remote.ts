import { z } from 'zod'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {
  MemoryConfigSnapshot,
  RoleAssetData,
  RoleCatalogSnapshot,
  SaveMemoryConfigInput,
  SaveRoleInput,
  SelectThemeBackgroundInput,
  SessionRoleSnapshot,
  UploadRoleAssetInput,
  WorkspaceRoleSnapshot,
} from './types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    shioriRole: {
      snapshot: (workspaceId: string) => Promise<RemoteResult<WorkspaceRoleSnapshot>>
      select: (workspaceId: string, roleId: string) => Promise<RemoteResult<WorkspaceRoleSnapshot>>
      catalogSnapshot: () => Promise<RemoteResult<RoleCatalogSnapshot>>
      saveRole: (input: SaveRoleInput) => Promise<RemoteResult<RoleCatalogSnapshot>>
      deleteRole: (roleId: string) => Promise<RemoteResult<RoleCatalogSnapshot>>
      uploadAsset: (input: UploadRoleAssetInput) => Promise<RemoteResult<RoleCatalogSnapshot>>
      removeAsset: (assetId: string) => Promise<RemoteResult<RoleCatalogSnapshot>>
      assetData: (assetId: string) => Promise<RemoteResult<RoleAssetData>>
      selectThemeBackground: (input: SelectThemeBackgroundInput) => Promise<RemoteResult<RoleCatalogSnapshot>>
      clearThemeBackground: (roleId: string) => Promise<RemoteResult<RoleCatalogSnapshot>>
      sessionSnapshot: (sessionId: string) => Promise<RemoteResult<SessionRoleSnapshot>>
      stageSessionRole: (sessionId: string, roleId: string) => Promise<RemoteResult<SessionRoleSnapshot>>
      memoryConfigSnapshot: () => Promise<RemoteResult<MemoryConfigSnapshot>>
      saveMemoryConfig: (input: SaveMemoryConfigInput) => Promise<RemoteResult<MemoryConfigSnapshot>>
    }
  }
}

const imageAttachmentRefSchema = z.object({
  attachmentId: z.string(),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string().optional(),
})

const assetSchema = z.object({
  id: z.string(),
  roleId: z.string(),
  purpose: z.enum(['avatar', 'portrait', 'gallery', 'theme_background']),
  attachment: imageAttachmentRefSchema,
  createdAt: z.string(),
})

const roleSchema = z.object({
  id: z.string(),
  name: z.string(),
  introduction: z.string(),
  prompt: z.string(),
  assets: z.array(assetSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const catalogSchema = z.object({ roles: z.array(roleSchema) })
const workspaceSnapshotSchema = catalogSchema.extend({
  workspaceId: z.string(),
  activeRoleId: z.string().optional(),
})
const sessionSnapshotSchema = catalogSchema.extend({
  sessionId: z.string(),
  roleId: z.string().optional(),
  pendingRoleId: z.string().optional(),
  locked: z.boolean(),
})
const saveRoleSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  introduction: z.string(),
  prompt: z.string(),
})
const uploadAssetSchema = z.object({
  roleId: z.string(),
  purpose: z.enum(['avatar', 'portrait', 'gallery', 'theme_background']),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  data: z.string(),
  name: z.string().optional(),
})
const selectThemeBackgroundSchema = z.object({
  roleId: z.string(),
  assetId: z.string(),
})
const memoryEndpointSchema = z.object({
  endpoint: z.string(),
  apiKey: z.string().optional(),
  model: z.string(),
})
const memoryConfigSnapshotSchema = z.object({
  embedding: memoryEndpointSchema.optional(),
  extraction: memoryEndpointSchema.optional(),
  updatedAt: z.string().optional(),
})
const saveMemoryConfigSchema = memoryConfigSnapshotSchema.omit({ updatedAt: true })

const json = (name: string, schema: z.ZodType) => ({
  name,
  wire: name,
  source: 'json' as const,
  codec: { mode: 'strict' as const, typeSymbol: 'unknown', schema },
})

const result = (typeSymbol: string, schema: z.ZodType) => ({ mode: 'strict' as const, typeSymbol, schema })

/** Client Remote descriptor contributed by this plugin. */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: '@deepseek-ai/dsh-plugin-shiori-role',
  descriptors: [
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/snapshot', service: 'shioriRole', namespace: 'shioriRole', method: 'snapshot', invocation: { kind: 'direct' },
      parameters: [json('workspaceId', z.string())], result: result('@deepseek-ai/dsh-plugin-shiori-role#WorkspaceRoleSnapshot', workspaceSnapshotSchema),
    },
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/select', service: 'shioriRole', namespace: 'shioriRole', method: 'select', implementation: 'selectRemote', invocation: { kind: 'direct' },
      parameters: [json('workspaceId', z.string()), json('roleId', z.string())], result: result('@deepseek-ai/dsh-plugin-shiori-role#WorkspaceRoleSnapshot', workspaceSnapshotSchema),
    },
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/catalogSnapshot', service: 'shioriRole', namespace: 'shioriRole', method: 'catalogSnapshot', invocation: { kind: 'direct' },
      parameters: [], result: result('@deepseek-ai/dsh-plugin-shiori-role#RoleCatalogSnapshot', catalogSchema),
    },
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/saveRole', service: 'shioriRole', namespace: 'shioriRole', method: 'saveRole', invocation: { kind: 'direct' },
      parameters: [json('input', saveRoleSchema)], result: result('@deepseek-ai/dsh-plugin-shiori-role#RoleCatalogSnapshot', catalogSchema),
    },
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/deleteRole', service: 'shioriRole', namespace: 'shioriRole', method: 'deleteRole', invocation: { kind: 'direct' },
      parameters: [json('roleId', z.string())], result: result('@deepseek-ai/dsh-plugin-shiori-role#RoleCatalogSnapshot', catalogSchema),
    },
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/uploadAsset', service: 'shioriRole', namespace: 'shioriRole', method: 'uploadAsset', invocation: { kind: 'direct' },
      parameters: [json('input', uploadAssetSchema)], result: result('@deepseek-ai/dsh-plugin-shiori-role#RoleCatalogSnapshot', catalogSchema),
    },
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/removeAsset', service: 'shioriRole', namespace: 'shioriRole', method: 'removeAsset', invocation: { kind: 'direct' },
      parameters: [json('assetId', z.string())], result: result('@deepseek-ai/dsh-plugin-shiori-role#RoleCatalogSnapshot', catalogSchema),
    },
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/assetData', service: 'shioriRole', namespace: 'shioriRole', method: 'assetData', invocation: { kind: 'direct' },
      parameters: [json('assetId', z.string())], result: result('@deepseek-ai/dsh-plugin-shiori-role#RoleAssetData', z.object({ asset: assetSchema, data: z.string() })),
    },
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/selectThemeBackground', service: 'shioriRole', namespace: 'shioriRole', method: 'selectThemeBackground', invocation: { kind: 'direct' },
      parameters: [json('input', selectThemeBackgroundSchema)], result: result('@deepseek-ai/dsh-plugin-shiori-role#RoleCatalogSnapshot', catalogSchema),
    },
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/clearThemeBackground', service: 'shioriRole', namespace: 'shioriRole', method: 'clearThemeBackground', invocation: { kind: 'direct' },
      parameters: [json('roleId', z.string())], result: result('@deepseek-ai/dsh-plugin-shiori-role#RoleCatalogSnapshot', catalogSchema),
    },
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/sessionSnapshot', service: 'shioriRole', namespace: 'shioriRole', method: 'sessionSnapshot', invocation: { kind: 'direct' },
      parameters: [json('sessionId', z.string())], result: result('@deepseek-ai/dsh-plugin-shiori-role#SessionRoleSnapshot', sessionSnapshotSchema),
    },
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/stageSessionRole', service: 'shioriRole', namespace: 'shioriRole', method: 'stageSessionRole', invocation: { kind: 'direct' },
      parameters: [json('sessionId', z.string()), json('roleId', z.string())], result: result('@deepseek-ai/dsh-plugin-shiori-role#SessionRoleSnapshot', sessionSnapshotSchema),
    },
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/memoryConfigSnapshot', service: 'shioriRole', namespace: 'shioriRole', method: 'memoryConfigSnapshot', invocation: { kind: 'direct' },
      parameters: [], result: result('@deepseek-ai/dsh-plugin-shiori-role#MemoryConfigSnapshot', memoryConfigSnapshotSchema),
    },
    {
      id: '@deepseek-ai/dsh-plugin-shiori-role#shioriRole/saveMemoryConfig', service: 'shioriRole', namespace: 'shioriRole', method: 'saveMemoryConfig', invocation: { kind: 'direct' },
      parameters: [json('input', saveMemoryConfigSchema)], result: result('@deepseek-ai/dsh-plugin-shiori-role#MemoryConfigSnapshot', memoryConfigSnapshotSchema),
    },
  ],
}

export default TYPERT_REMOTE
