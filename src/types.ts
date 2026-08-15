import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Stable identity and prompt metadata for one Shiori role. */
export interface ShioriRoleDefinition {
  /** Stable role id used by workspace and session bindings. */
  readonly id: string
  /** Human-readable role name for host surfaces. */
  readonly name: string
  /** Short introduction shown on role-management surfaces. */
  readonly introduction?: string
  /** Identity and behavior text contributed to the Agent prompt. */
  readonly prompt: string
}

/** Extensible semantic purpose for a role-owned image. */
export type RoleAssetPurpose = 'avatar' | 'portrait' | 'gallery' | 'theme_background'

/** Durable role-owned image metadata. Binary data remains in Harness attachment storage. */
export interface RoleAssetView {
  readonly id: string
  readonly roleId: string
  readonly purpose: RoleAssetPurpose
  readonly attachment: ImageAttachmentRef
  readonly createdAt: string
}

/** Client-safe editable role row. */
export interface ShioriRoleView {
  readonly id: string
  readonly name: string
  readonly introduction: string
  readonly prompt: string
  readonly assets: readonly RoleAssetView[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** Role catalog and active selection for one workspace. */
export interface WorkspaceRoleSnapshot {
  readonly workspaceId: string
  readonly roles: readonly ShioriRoleView[]
  readonly activeRoleId?: string
}

/** Complete role catalog used by settings and composer surfaces. */
export interface RoleCatalogSnapshot {
  readonly roles: readonly ShioriRoleView[]
}

/** Current mutable or committed role state for one conversation session. */
export interface SessionRoleSnapshot extends RoleCatalogSnapshot {
  readonly sessionId: string
  readonly roleId?: string
  readonly pendingRoleId?: string
  readonly locked: boolean
}

/** Role fields accepted by create and update operations. */
export interface SaveRoleInput {
  readonly id?: string
  readonly name: string
  readonly introduction: string
  readonly prompt: string
}

/** Browser image payload transported to the host attachment boundary. */
export interface UploadRoleAssetInput {
  readonly roleId: string
  readonly purpose: RoleAssetPurpose
  readonly mediaType: ImageMediaType
  readonly data: string
  readonly name?: string
}

/** Promote one gallery asset to the role's single theme background. */
export interface SelectThemeBackgroundInput {
  readonly roleId: string
  readonly assetId: string
}

/** Browser-readable immutable image payload. */
export interface RoleAssetData {
  readonly asset: RoleAssetView
  readonly data: string
}

/** OpenAI 兼容端点配置（embedding / extraction 共用）。 */
export interface MemoryEndpointConfig {
  readonly endpoint: string
  readonly apiKey?: string | undefined
  readonly model: string
}

/** Client-safe memory configuration snapshot. */
export interface MemoryConfigSnapshot {
  readonly embedding?: MemoryEndpointConfig
  readonly extraction?: MemoryEndpointConfig
  readonly updatedAt?: string
}

/** Memory configuration accepted by the save operation. */
export interface SaveMemoryConfigInput {
  readonly embedding?: MemoryEndpointConfig
  readonly extraction?: MemoryEndpointConfig
}
