import { useEffect, useState } from 'react'
import type { RoleAssetView } from '../types.ts'
import type { RoleClientApi } from './api.ts'

const dataUrls = new Map<string, string>()

/** Resolve a role asset through the verified host read path and cache its immutable data URL. */
export function useAssetUrl(api: RoleClientApi, asset: RoleAssetView | undefined): string | undefined {
  const assetId = asset?.id
  const [url, setUrl] = useState<string | undefined>(() => assetId === undefined ? undefined : dataUrls.get(assetId))

  useEffect(() => {
    if (asset === undefined) {
      setUrl(undefined)
      return
    }
    const cached = dataUrls.get(asset.id)
    if (cached !== undefined) {
      setUrl(cached)
      return
    }
    let alive = true
    void api.assetData(asset.id).then(result => {
      if (!alive) return
      const next = `data:${result.asset.attachment.mediaType};base64,${result.data}`
      dataUrls.set(asset.id, next)
      setUrl(next)
    })
    return () => { alive = false }
  }, [api, asset, assetId])

  return url
}

/** Find the singular role asset for a semantic purpose. */
export function primaryAsset(role: { assets: readonly RoleAssetView[] }, purpose: RoleAssetView['purpose']) {
  return role.assets.find(asset => asset.purpose === purpose)
}
