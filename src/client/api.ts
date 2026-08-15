import type {
  MemoryConfigSnapshot,
  RoleAssetData,
  RoleCatalogSnapshot,
  SaveMemoryConfigInput,
  SaveRoleInput,
  SelectThemeBackgroundInput,
  SessionRoleSnapshot,
  UploadRoleAssetInput,
} from '../types.ts'

/** Client-facing role operations after RemoteResult unwrapping. */
export interface RoleClientApi {
  catalog(): Promise<RoleCatalogSnapshot>
  saveRole(input: SaveRoleInput): Promise<RoleCatalogSnapshot>
  deleteRole(roleId: string): Promise<RoleCatalogSnapshot>
  uploadAsset(input: UploadRoleAssetInput): Promise<RoleCatalogSnapshot>
  removeAsset(assetId: string): Promise<RoleCatalogSnapshot>
  assetData(assetId: string): Promise<RoleAssetData>
  selectBackground(input: SelectThemeBackgroundInput): Promise<RoleCatalogSnapshot>
  clearBackground(roleId: string): Promise<RoleCatalogSnapshot>
  session(sessionId: string): Promise<SessionRoleSnapshot>
  stage(sessionId: string, roleId: string): Promise<SessionRoleSnapshot>
  memoryConfig(): Promise<MemoryConfigSnapshot>
  saveMemoryConfig(input: SaveMemoryConfigInput): Promise<MemoryConfigSnapshot>
  /** Subscribe to successful role catalog mutations from any plugin surface. */
  subscribeCatalog(listener: () => void): () => void
}

/** Convert a browser image to the canonical base64 payload expected by the host. */
export async function filePayload(file: File): Promise<string> {
  const data = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}
