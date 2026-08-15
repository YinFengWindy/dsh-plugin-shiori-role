import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconUserOutline16, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionRoleSnapshot, ShioriRoleView } from '../types.ts'
import type { RoleClientApi } from './api.ts'
import { primaryAsset, useAssetUrl } from './assets.ts'
import { useRoleTheme } from './theme.ts'
import type { RoleText } from './RoleSettings.tsx'

interface RoleSelectorProps {
  readonly session: { readonly sessionId: string; readonly blank: boolean }
  readonly api: RoleClientApi
  readonly t: RoleText
}

function Avatar({ role, api }: { role: ShioriRoleView; api: RoleClientApi }) {
  const url = useAssetUrl(api, primaryAsset(role, 'avatar'))
  return <span className="shiori-role-chip__avatar">{url === undefined ? <IconUserOutline16 size={16} /> : <img src={url} alt="" />}</span>
}

export function RoleSelector({ session, api, t }: RoleSelectorProps) {
  const [snapshot, setSnapshot] = useState<SessionRoleSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    setSnapshot(null)
    setError(null)
    void api.session(session.sessionId).then(setSnapshot, cause => { setError(messageOf(cause)) })
  }, [api, session.sessionId])
  useEffect(load, [load])
  useEffect(() => api.subscribeCatalog(load), [api, load])

  const selectedId = snapshot?.roleId ?? snapshot?.pendingRoleId
  const role = snapshot?.roles.find(item => item.id === selectedId)
  const themeAsset = role === undefined ? undefined : (primaryAsset(role, 'theme_background') ?? primaryAsset(role, 'portrait'))
  const themeUrl = useAssetUrl(api, themeAsset)
  useRoleTheme(role, themeUrl)
  const locked = snapshot?.locked === true || !session.blank
  const items = useMemo(() => snapshot?.roles.map(item => ({
    id: item.id,
    label: item.name,
    icon: <Avatar role={item} api={api} />,
  })) ?? [], [api, snapshot?.roles])

  if (snapshot === null && error === null) return null
  return (
    <Menu
      open={open}
      portal
      compact
      items={items}
      selectedId={selectedId}
      onClose={() => { setOpen(false) }}
      onSelect={roleId => {
        if (locked || busy) return
        setBusy(true)
        setError(null)
        void api.stage(session.sessionId, roleId)
          .then(setSnapshot, cause => { setError(messageOf(cause)) })
          .finally(() => { setBusy(false); setOpen(false) })
      }}
      anchor={(
        <button
          type="button"
          className="shiori-role-chip"
          disabled={locked || busy || items.length === 0}
          title={error ?? (locked ? t('fixedRole') : t('chooseRole'))}
          onClick={() => { if (!locked) setOpen(value => !value) }}
        >
          {role === undefined ? <span className="shiori-role-chip__avatar"><IconUserOutline16 size={16} /></span> : <Avatar role={role} api={api} />}
          <span className="shiori-role-chip__name">{role?.name ?? t('chooseRole')}</span>
        </button>
      )}
    />
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
