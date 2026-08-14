import { useEffect } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { ShioriRoleView } from '../types.ts'

const THEME_SOURCE = '@deepseek-ai/dsh-plugin-shiori-role'

/** Apply a role accent and illustration layer without changing theme preference. */
export function useRoleTheme(ctx: ClientContext, role: ShioriRoleView | undefined, portraitUrl: string | undefined): void {
  useEffect(() => {
    if (role === undefined) return
    let disposed = false
    let disposeTokens: (() => void) | undefined
    const root = document.documentElement

    const apply = async () => {
      const accent = portraitUrl === undefined ? fallbackAccent(role.id) : await dominantAccent(portraitUrl, role.id)
      if (disposed) return
      disposeTokens = ctx.theme.overrideTokens(THEME_SOURCE, {
        '--dsw-alias-brand-primary': { light: accent.light, dark: accent.dark },
        '--dsw-specific-sidebar-fill': { light: accent.sidebarLight, dark: accent.sidebarDark },
      })
      root.classList.add('shiori-role-theme')
      if (portraitUrl !== undefined) root.style.setProperty('--shiori-role-art', `url(${JSON.stringify(portraitUrl)})`)
      else root.style.removeProperty('--shiori-role-art')
      root.style.setProperty('--shiori-role-overlay', 'color-mix(in srgb,var(--dsw-specific-sidebar-fill) 88%,transparent)')
      root.style.setProperty('--shiori-role-workspace-overlay', 'color-mix(in srgb,var(--dsw-alias-bg-base) 94%,transparent)')
    }
    void apply()
    return () => {
      disposed = true
      disposeTokens?.()
      root.classList.remove('shiori-role-theme')
      root.style.removeProperty('--shiori-role-art')
      root.style.removeProperty('--shiori-role-overlay')
      root.style.removeProperty('--shiori-role-workspace-overlay')
    }
  }, [ctx, portraitUrl, role])
}

async function dominantAccent(url: string, seed: string) {
  try {
    const image = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = 24
    canvas.height = 24
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return fallbackAccent(seed)
    context.drawImage(image, 0, 0, 24, 24)
    const pixels = context.getImageData(0, 0, 24, 24).data
    let red = 0
    let green = 0
    let blue = 0
    let count = 0
    for (let index = 0; index < pixels.length; index += 16) {
      if ((pixels[index + 3] ?? 0) < 96) continue
      red += pixels[index] ?? 0
      green += pixels[index + 1] ?? 0
      blue += pixels[index + 2] ?? 0
      count += 1
    }
    if (count === 0) return fallbackAccent(seed)
    return palette(red / count, green / count, blue / count)
  } catch {
    return fallbackAccent(seed)
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => { resolve(image) }
    image.onerror = () => { reject(new Error('role portrait could not be decoded')) }
    image.src = url
  })
}

function fallbackAccent(seed: string) {
  let hash = 0
  for (const character of seed) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0
  const hue = Math.abs(hash) % 360
  return {
    light: `hsl(${hue} 44% 42%)`,
    dark: `hsl(${hue} 55% 66%)`,
    sidebarLight: `hsl(${hue} 20% 96%)`,
    sidebarDark: `hsl(${hue} 15% 15%)`,
  }
}

function palette(red: number, green: number, blue: number) {
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  let hue = 0
  if (delta > 0) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6)
    else if (max === green) hue = 60 * ((blue - red) / delta + 2)
    else hue = 60 * ((red - green) / delta + 4)
  }
  if (hue < 0) hue += 360
  return {
    light: `hsl(${hue.toFixed(0)} 46% 40%)`,
    dark: `hsl(${hue.toFixed(0)} 58% 68%)`,
    sidebarLight: `hsl(${hue.toFixed(0)} 22% 96%)`,
    sidebarDark: `hsl(${hue.toFixed(0)} 17% 15%)`,
  }
}
