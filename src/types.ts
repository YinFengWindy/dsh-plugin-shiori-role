/** Stable identity and prompt metadata for one Shiori role. */
export interface ShioriRoleDefinition {
  /** Stable role id used by workspace and session bindings. */
  readonly id: string
  /** Human-readable role name for host surfaces. */
  readonly name: string
  /** Identity and behavior text contributed to the Agent prompt. */
  readonly prompt: string
}

/** Client-safe role row without the model-facing prompt. */
export interface ShioriRoleView {
  readonly id: string
  readonly name: string
}

/** Role catalog and active selection for one workspace. */
export interface WorkspaceRoleSnapshot {
  readonly workspaceId: string
  readonly roles: readonly ShioriRoleView[]
  readonly activeRoleId?: string
}
