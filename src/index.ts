/** Native Cordis role plugin for Shiori characters. */

export { apply, inject, name, type Config } from './role-plugin.ts'
import { ShioriRoleService } from './service.ts'

export type { ShioriRoleDefinition } from './types.ts'
export { ShioriRoleService } from './service.ts'
export {
  shioriRoleDomainSpec,
  sessionRoleRecord,
  workspaceRoleRecord,
  type SessionRoleRecord,
  type WorkspaceRoleRecord,
  type RoleMemoryRecord,
} from './spec.ts'
export { ShioriMemoryService, applyMemoryTools } from './memory.ts'
export {
  DuplicateRoleError,
  MemoryRoleSelectionStore,
  UnknownRoleError,
  WorkspaceRoleRegistry,
  type RoleSelectionStore,
  type WorkspaceKey,
} from './registry.ts'

export default ShioriRoleService
