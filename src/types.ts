/** Stable identity and prompt metadata for one Shiori role. */
export interface ShioriRoleDefinition {
  /** Stable role id used by workspace and session bindings. */
  readonly id: string
  /** Human-readable role name for host surfaces. */
  readonly name: string
  /** Identity and behavior text contributed to the Agent prompt. */
  readonly prompt: string
}
