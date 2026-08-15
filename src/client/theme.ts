import { useEffect } from 'react'
import type { ShioriRoleView } from '../types.ts'

/**
 * Apply a role-owned illustration layer without changing theme preference or
 * accent colors: the selected background image (falling back to the portrait)
 * tints the sidebar rail and the conversation scrollport.
 * @param role - the active role; the layer applies only while one is bound.
 * @param backgroundUrl - the role's theme background image URL, if any.
 */
export function useRoleTheme(role: ShioriRoleView | undefined, backgroundUrl: string | undefined): void {
  useEffect(() => {
    if (role === undefined) return
    const root = document.documentElement
    root.classList.add('shiori-role-theme')
    if (backgroundUrl !== undefined) root.style.setProperty('--shiori-role-art', `url(${JSON.stringify(backgroundUrl)})`)
    else root.style.removeProperty('--shiori-role-art')
    root.style.setProperty('--shiori-role-overlay', 'color-mix(in srgb,var(--dsw-specific-sidebar-fill) 82%,transparent)')
    root.style.setProperty('--shiori-role-workspace-overlay', 'color-mix(in srgb,var(--dsw-alias-bg-base) 72%,transparent)')
    console.info('[shiori-role] theme applied', { role: role.id, art: backgroundUrl === undefined ? '(none)' : 'set' })
    return () => {
      root.classList.remove('shiori-role-theme')
      root.style.removeProperty('--shiori-role-art')
      root.style.removeProperty('--shiori-role-overlay')
      root.style.removeProperty('--shiori-role-workspace-overlay')
    }
  }, [backgroundUrl, role])
}
