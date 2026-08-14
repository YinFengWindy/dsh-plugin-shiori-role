import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import remote from '../remote.ts'
import type { WorkspaceRoleSnapshot } from '../types.ts'

const NS = 'shiori.role'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'shiori.role': keyof typeof dictionaries.en
  }
}

const dictionaries = {
  en: {
    tab: 'Roles', workspace: 'Workspace', role: 'Role', loading: 'Loading...', error: 'Unable to load roles', retry: 'Retry', selected: 'Active',
  },
  zh: {
    tab: '角色', workspace: '工作区', role: '角色', loading: '加载中...', error: '角色加载失败', retry: '重试', selected: '当前',
  },
}

interface RoleTabInjected {
  readonly workspaces: ClientContext['workspaces']['list']
  snapshot(workspaceId: string): Promise<WorkspaceRoleSnapshot>
  select(workspaceId: string, roleId: string): Promise<WorkspaceRoleSnapshot>
}

interface RoleTabProps extends RoleTabInjected {
  t(key: keyof typeof dictionaries.en): string
}

interface ShioriRoleRemote {
  snapshot(workspaceId: string): ReturnType<ClientContext['remote']['shioriRole']['snapshot']>
  select(workspaceId: string, roleId: string): ReturnType<ClientContext['remote']['shioriRole']['select']>
}

function RoleTab({ workspaces, snapshot, select, t }: RoleTabProps) {
  const workspaceState = useSyncExternalStore(workspaces.subscribe, workspaces.getSnapshot, workspaces.getSnapshot)
  const [workspaceId, setWorkspaceId] = useState('')
  const [state, setState] = useState<WorkspaceRoleSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const currentWorkspace = useMemo(
    () => workspaceState.items.find(item => item.workspaceId === workspaceId),
    [workspaceId, workspaceState.items],
  )

  useEffect(() => {
    if (workspaceId || workspaceState.items.length === 0) return
    setWorkspaceId(String(workspaceState.recentWorkspaceId ?? workspaceState.items[0]?.workspaceId ?? ''))
  }, [workspaceId, workspaceState.items, workspaceState.recentWorkspaceId])

  const load = useCallback((): void => {
    if (!workspaceId) return
    setError(null)
    setState(null)
    void snapshot(workspaceId).then(setState, cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [snapshot, workspaceId])

  useEffect(load, [load])

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 620 }}>
      <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
        <span>{t('workspace')}</span>
        <select
          value={workspaceId}
          onChange={event => { setWorkspaceId(event.currentTarget.value) }}
          style={{ minHeight: 36, padding: '0 10px', borderRadius: 6 }}
        >
          {workspaceState.items.map(workspace => (
            <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
          ))}
        </select>
      </label>
      {error !== null ? <div role="alert"><span>{t('error')}: {error}</span> <Button variant="outline" onClick={load}>{t('retry')}</Button></div> : null}
      {error === null && workspaceId && state === null ? <p>{t('loading')}</p> : null}
      {state !== null && currentWorkspace !== undefined ? (
        <div style={{ display: 'grid', gap: 8 }} aria-label={t('role')}>
          {state.roles.map(role => {
            const active = role.id === state.activeRoleId
            return (
              <Button
                key={role.id}
                variant={active ? 'primary' : 'outline'}
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  setError(null)
                  void select(workspaceId, role.id)
                    .then(setState, cause => {
                      setError(cause instanceof Error ? cause.message : String(cause))
                    })
                    .finally(() => { setBusy(false) })
                }}
              >
                {role.name}{active ? ` · ${t('selected')}` : ''}
              </Button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export const inject = ['slots', 'locale', 'remote', 'workspaces']

/** Mount the generated Remote face and contribute the workspace role tab. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(remote)
  const roleRemote = ctx.get('remote.shioriRole') as ShioriRoleRemote | undefined
  if (roleRemote === undefined) {
    await disposeRemote()
    throw new Error('shiori-role: Remote namespace did not start')
  }
  const disposeLocale = ctx.locale.register(NS, dictionaries)
  const t = ctx.locale.bind(NS)
  const disposeTab = await ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'shiori-roles',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: (): RoleTabInjected => ({
      workspaces: ctx.workspaces.list,
      snapshot: async (workspaceId) => {
        const result = await roleRemote.snapshot(workspaceId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      select: async (workspaceId, roleId) => {
        const result = await roleRemote.select(workspaceId, roleId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
    }),
  }, RoleTab))
  return async () => {
    disposeTab()
    disposeLocale()
    await disposeRemote()
  }
}
