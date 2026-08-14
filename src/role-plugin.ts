import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { PERSONA_ORDER, PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type { ShioriRoleDefinition } from './types.ts'

/** Cordis plugin display name. */
export const name = 'shiori-role'

/** Services required by the role prompt contribution. */
export const inject = ['systemPrompt']

/** Plugin configuration for one mounted role. */
export interface Config extends ShioriRoleDefinition {}

/**
 * Register one role's identity in the current Agent scope.
 *
 * The caller is responsible for mounting this plugin inside the Agent scope
 * selected for a session. Disposal of that scope removes the contribution.
 * @param ctx - the Cordis context for the role's Agent scope.
 * @param config - the stable role identity and prompt text.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.id.trim()) throw new Error('shiori-role: id must not be empty')
  if (!config.name.trim()) throw new Error('shiori-role: name must not be empty')
  if (!config.prompt.trim()) throw new Error('shiori-role: prompt must not be empty')

  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_SECTION,
    order: PERSONA_ORDER,
    text: config.prompt,
  }), 'shiori-role.persona()')
}
