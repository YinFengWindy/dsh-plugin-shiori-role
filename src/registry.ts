import type { ShioriRoleDefinition } from './types.ts'

/** Identifies a workspace without coupling the role package to a host id brand. */
export type WorkspaceKey = string

/** Persists the active role selection for one workspace. */
export interface RoleSelectionStore {
  /** Read the role selected for a workspace. */
  get(workspace: WorkspaceKey): Promise<string | undefined>
  /** Persist the role selected for a workspace. */
  set(workspace: WorkspaceKey, roleId: string): Promise<void>
}

/** In-memory selection store for composition tests and embedders without persistence. */
export class MemoryRoleSelectionStore implements RoleSelectionStore {
  private readonly values = new Map<WorkspaceKey, string>()

  async get(workspace: WorkspaceKey): Promise<string | undefined> {
    return this.values.get(workspace)
  }

  async set(workspace: WorkspaceKey, roleId: string): Promise<void> {
    this.values.set(workspace, roleId)
  }
}

/** Error raised when a role id is not present in the configured catalog. */
export class UnknownRoleError extends Error {
  constructor(readonly roleId: string) {
    super(`unknown Shiori role '${roleId}'`)
    this.name = 'UnknownRoleError'
  }
}

/** Error raised when two role definitions claim the same stable id. */
export class DuplicateRoleError extends Error {
  constructor(readonly roleId: string) {
    super(`duplicate Shiori role '${roleId}'`)
    this.name = 'DuplicateRoleError'
  }
}

/**
 * Validated role catalog plus workspace-level active-role selection.
 *
 * A selection is only a default for future Agent creation. Callers should
 * resolve it while creating an Agent and persist the resolved id with that
 * session; existing Agents must keep their original role binding.
 */
export class WorkspaceRoleRegistry {
  private readonly roles: ReadonlyMap<string, ShioriRoleDefinition>

  constructor(
    definitions: readonly ShioriRoleDefinition[],
    private readonly selections: RoleSelectionStore,
  ) {
    const roles = new Map<string, ShioriRoleDefinition>()
    for (const definition of definitions) {
      const id = definition.id.trim()
      if (!id) throw new Error('Shiori role id must not be empty')
      if (!definition.name.trim()) throw new Error(`Shiori role '${id}' name must not be empty`)
      if (!definition.prompt.trim()) throw new Error(`Shiori role '${id}' prompt must not be empty`)
      if (roles.has(id)) throw new DuplicateRoleError(id)
      roles.set(id, Object.freeze({ ...definition, id }))
    }
    this.roles = roles
  }

  /** List roles in catalog order. */
  list(): readonly ShioriRoleDefinition[] {
    return [...this.roles.values()]
  }

  /** Resolve a role by stable id. */
  get(roleId: string): ShioriRoleDefinition | undefined {
    return this.roles.get(roleId)
  }

  /** Read the active role for a workspace, if one has been selected. */
  async active(workspace: WorkspaceKey): Promise<ShioriRoleDefinition | undefined> {
    const roleId = await this.selections.get(workspace)
    return roleId === undefined ? undefined : this.require(roleId)
  }

  /** Select a role for future Agents created in a workspace. */
  async select(workspace: WorkspaceKey, roleId: string): Promise<void> {
    this.require(roleId)
    await this.selections.set(workspace, roleId)
  }

  /** Resolve a role or fail loudly at the Agent-creation boundary. */
  require(roleId: string): ShioriRoleDefinition {
    const role = this.roles.get(roleId)
    if (role === undefined) throw new UnknownRoleError(roleId)
    return role
  }
}
