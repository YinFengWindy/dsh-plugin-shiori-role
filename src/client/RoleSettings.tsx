import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  IconPlusOutline16,
  IconTrashOutline16,
  IconUserOutline16,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { MemoryConfigSnapshot, MemoryEndpointConfig, RoleAssetPurpose, RoleCatalogSnapshot, SaveMemoryConfigInput, ShioriRoleView } from '../types.ts'
import type { RoleClientApi } from './api.ts'
import { filePayload } from './api.ts'
import { primaryAsset, useAssetUrl } from './assets.ts'

export type RoleLocaleKey =
  | 'tab' | 'loading' | 'create' | 'createTitle' | 'editTitle' | 'close' | 'delete' | 'cancel' | 'save'
  | 'name' | 'introduction' | 'systemPrompt' | 'avatar' | 'portrait' | 'assets'
  | 'fixedRole' | 'chooseRole'
  | 'memory' | 'memoryHint' | 'embedding' | 'extraction' | 'endpoint' | 'model' | 'apiKey' | 'dbPath'
  | 'saveMemory' | 'memorySaved' | 'memoryError'
export type RoleText = (key: RoleLocaleKey) => string

interface RoleSettingsProps {
  readonly api: RoleClientApi
  readonly t: RoleText
}

const EMPTY_ROLE = { name: '', introduction: '', prompt: '' }

function RoleCard({ role, api, onOpen }: { role: ShioriRoleView; api: RoleClientApi; onOpen: () => void }) {
  const portrait = useAssetUrl(api, primaryAsset(role, 'portrait'))
  return (
    <button type="button" className="shiori-role-card" onClick={onOpen}>
      {portrait === undefined ? null : <span className="shiori-role-card__art" style={{ backgroundImage: `url(${JSON.stringify(portrait)})` }} />}
      <span className="shiori-role-card__shade" />
      <span className="shiori-role-card__copy">
        <span className="shiori-role-card__name">{role.name}</span>
        <span className="shiori-role-card__intro">{role.introduction}</span>
      </span>
    </button>
  )
}

function AssetPreview({ role, purpose, api }: { role: ShioriRoleView; purpose: RoleAssetPurpose; api: RoleClientApi }) {
  const url = useAssetUrl(api, primaryAsset(role, purpose))
  return url === undefined ? <IconUserOutline16 size={24} /> : <img src={url} alt="" />
}

function GalleryImage({ assetId, role, api, onRemove }: {
  assetId: string
  role: ShioriRoleView
  api: RoleClientApi
  onRemove: (assetId: string) => void
}) {
  const asset = role.assets.find(item => item.id === assetId)
  const url = useAssetUrl(api, asset)
  return (
    <div className="shiori-role-gallery__item">
      {url === undefined ? null : <img src={url} alt="" />}
      <button type="button" className="shiori-role-gallery__remove" aria-label="Remove" onClick={() => { onRemove(assetId) }}>
        <IconTrashOutline16 size={14} />
      </button>
    </div>
  )
}

export function RoleSettings({ api, t }: RoleSettingsProps) {
  const [catalog, setCatalog] = useState<RoleCatalogSnapshot | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState(EMPTY_ROLE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editing = catalog?.roles.find(role => role.id === editingId)

  const load = useCallback(() => {
    setError(null)
    void api.catalog().then(setCatalog, cause => { setError(messageOf(cause)) })
  }, [api])

  useEffect(load, [load])

  const open = (role?: ShioriRoleView) => {
    setEditingId(role?.id ?? '')
    setDraft(role === undefined
      ? EMPTY_ROLE
      : { name: role.name, introduction: role.introduction, prompt: role.prompt })
    setError(null)
  }

  const close = () => {
    if (busy) return
    setEditingId(null)
    setError(null)
  }

  const run = async (operation: () => Promise<RoleCatalogSnapshot>) => {
    setBusy(true)
    setError(null)
    try {
      const next = await operation()
      setCatalog(next)
      return next
    } catch (cause) {
      setError(messageOf(cause))
      return null
    } finally {
      setBusy(false)
    }
  }

  const upload = async (purpose: RoleAssetPurpose, file: File) => {
    if (editing === undefined) return
    const mediaType = imageMediaType(file.type)
    await run(async () => api.uploadAsset({
      roleId: editing.id,
      purpose,
      mediaType,
      data: await filePayload(file),
      ...(file.name ? { name: file.name } : {}),
    }))
  }

  return (
    <>
      {error !== null && editingId === null ? <div role="alert" className="shiori-role-error">{error}</div> : null}
      {catalog === null && error === null ? <p>{t('loading')}</p> : null}
      {catalog !== null ? (
        <div className="shiori-role-grid">
          {catalog.roles.map(role => <RoleCard key={role.id} role={role} api={api} onOpen={() => { open(role) }} />)}
          <button type="button" className="shiori-role-card shiori-role-card--create" onClick={() => { open() }}>
            <span className="shiori-role-create__body"><IconPlusOutline16 size={24} /><span>{t('create')}</span></span>
          </button>
        </div>
      ) : null}
      <MemorySettings api={api} t={t} />
      <Modal
        open={editingId !== null}
        onClose={close}
        title={editing === undefined ? t('createTitle') : t('editTitle')}
        closeLabel={t('close')}
        className="shiori-role-modal"
        contentClassName="shiori-role-modal__content"
        footer={(
          <div className="shiori-role-footer">
            {editing === undefined ? null : (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => { void run(() => api.deleteRole(editing.id)).then(next => { if (next !== null) close() }) }}
              >
                <IconTrashOutline16 size={16} /> {t('delete')}
              </Button>
            )}
            <div className="shiori-role-footer__right">
              <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
              <Button
                variant="primary"
                disabled={busy || !draft.name.trim() || !draft.prompt.trim()}
                onClick={() => {
                  void run(() => api.saveRole({
                    ...(editing === undefined ? {} : { id: editing.id }),
                    ...draft,
                  })).then(next => {
                    if (next === null) return
                    close()
                  })
                }}
              >{t('save')}</Button>
            </div>
          </div>
        )}
      >
        <div className="shiori-role-form">
          <label className="shiori-role-field"><span>{t('name')}</span><Input value={draft.name} onChange={event => { const name = event.currentTarget.value; setDraft(value => ({ ...value, name })) }} /></label>
          <label className="shiori-role-field"><span>{t('introduction')}</span><Input value={draft.introduction} onChange={event => { const introduction = event.currentTarget.value; setDraft(value => ({ ...value, introduction })) }} /></label>
          <label className="shiori-role-field"><span>{t('systemPrompt')}</span><textarea value={draft.prompt} onChange={event => { const prompt = event.currentTarget.value; setDraft(value => ({ ...value, prompt })) }} /></label>
          {editing === undefined ? null : (
            <>
              <div className="shiori-role-media-row">
                <label className="shiori-role-field"><span>{t('avatar')}</span><span className="shiori-role-upload"><AssetPreview role={editing} purpose="avatar" api={api} /><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; if (file !== undefined) void upload('avatar', file); event.currentTarget.value = '' }} /></span></label>
                <label className="shiori-role-field"><span>{t('portrait')}</span><span className="shiori-role-upload"><AssetPreview role={editing} purpose="portrait" api={api} /><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; if (file !== undefined) void upload('portrait', file); event.currentTarget.value = '' }} /></span></label>
              </div>
              <div className="shiori-role-field">
                <span>{t('assets')}</span>
                <div className="shiori-role-gallery">
                  {editing.assets.filter(asset => asset.purpose === 'gallery').map(asset => <GalleryImage key={asset.id} assetId={asset.id} role={editing} api={api} onRemove={assetId => { void run(() => api.removeAsset(assetId)) }} />)}
                  <label className="shiori-role-upload"><IconPlusOutline16 size={20} /><input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={event => { const files = [...(event.currentTarget.files ?? [])]; void (async () => { for (const file of files) await upload('gallery', file) })(); event.currentTarget.value = '' }} /></label>
                </div>
              </div>
            </>
          )}
          {error === null ? null : <div role="alert" className="shiori-role-error">{error}</div>}
        </div>
      </Modal>
    </>
  )
}

function imageMediaType(value: string): ImageMediaType {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif') return value
  throw new Error(`Unsupported image type: ${value || 'unknown'}`)
}

type EndpointKind = 'embedding' | 'extraction'
type EndpointField = 'endpoint' | 'model' | 'apiKey'

/** 记忆语义层配置表单：embedding / extraction 端点，留空即禁用。 */
function MemorySettings({ api, t }: { api: RoleClientApi; t: RoleText }) {
  const [config, setConfig] = useState<MemoryConfigSnapshot | null>(null)
  const [draft, setDraft] = useState<SaveMemoryConfigInput>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = useCallback(() => {
    setError(null)
    void api.memoryConfig().then(next => {
      setConfig(next)
      setDraft(draftFrom(next))
    }, cause => { setError(messageOf(cause)) })
  }, [api])
  useEffect(load, [load])

  const setEndpointField = (kind: EndpointKind, field: EndpointField, value: string) => {
    setSaved(false)
    setDraft(current => {
      const endpoint = current[kind] ?? { endpoint: '', model: '' }
      return { ...current, [kind]: { ...endpoint, [field]: value } }
    })
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const input: SaveMemoryConfigInput = {
        ...(draft.embedding?.endpoint.trim() ? { embedding: cleanEndpoint(draft.embedding) } : {}),
        ...(draft.extraction?.endpoint.trim() ? { extraction: cleanEndpoint(draft.extraction) } : {}),
        ...(draft.dbPath?.trim() ? { dbPath: draft.dbPath.trim() } : {}),
      }
      const next = await api.saveMemoryConfig(input)
      setConfig(next)
      setDraft(draftFrom(next))
      setSaved(true)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="shiori-role-memory">
      <h3 className="shiori-role-memory__title">{t('memory')}</h3>
      <p className="shiori-role-memory__hint">{t('memoryHint')}</p>
      {config === null && error === null ? <p>{t('loading')}</p> : null}
      {config !== null ? (
        <div className="shiori-role-memory__grid">
          <fieldset className="shiori-role-memory__endpoint">
            <legend>{t('embedding')}</legend>
            <label className="shiori-role-field"><span>{t('endpoint')}</span><Input value={draft.embedding?.endpoint ?? ''} onChange={event => { setEndpointField('embedding', 'endpoint', event.currentTarget.value) }} placeholder="https://api.openai.com/v1" /></label>
            <label className="shiori-role-field"><span>{t('model')}</span><Input value={draft.embedding?.model ?? ''} onChange={event => { setEndpointField('embedding', 'model', event.currentTarget.value) }} placeholder="text-embedding-3-small" /></label>
            <label className="shiori-role-field"><span>{t('apiKey')}</span><Input type="password" value={draft.embedding?.apiKey ?? ''} onChange={event => { setEndpointField('embedding', 'apiKey', event.currentTarget.value) }} placeholder="sk-..." /></label>
          </fieldset>
          <fieldset className="shiori-role-memory__endpoint">
            <legend>{t('extraction')}</legend>
            <label className="shiori-role-field"><span>{t('endpoint')}</span><Input value={draft.extraction?.endpoint ?? ''} onChange={event => { setEndpointField('extraction', 'endpoint', event.currentTarget.value) }} placeholder="https://api.openai.com/v1" /></label>
            <label className="shiori-role-field"><span>{t('model')}</span><Input value={draft.extraction?.model ?? ''} onChange={event => { setEndpointField('extraction', 'model', event.currentTarget.value) }} placeholder="gpt-4o-mini" /></label>
            <label className="shiori-role-field"><span>{t('apiKey')}</span><Input type="password" value={draft.extraction?.apiKey ?? ''} onChange={event => { setEndpointField('extraction', 'apiKey', event.currentTarget.value) }} placeholder="sk-..." /></label>
          </fieldset>
        </div>
      ) : null}
      <label className="shiori-role-field shiori-role-memory__db"><span>{t('dbPath')}</span><Input value={draft.dbPath ?? ''} onChange={event => { setSaved(false); setDraft(current => ({ ...current, dbPath: event.currentTarget.value })) }} placeholder="shiori-plugin/role/memory2.db" /></label>
      <div className="shiori-role-memory__actions">
        <Button variant="primary" disabled={busy || config === null} onClick={() => { void save() }}>{t('saveMemory')}</Button>
        {saved ? <span className="shiori-role-memory__status">{t('memorySaved')}</span> : null}
      </div>
      {error === null ? null : <div role="alert" className="shiori-role-error">{error}</div>}
    </section>
  )
}

function cleanEndpoint(endpoint: MemoryEndpointConfig): MemoryEndpointConfig {
  return {
    endpoint: endpoint.endpoint.trim(),
    model: endpoint.model.trim(),
    ...(endpoint.apiKey?.trim() ? { apiKey: endpoint.apiKey.trim() } : {}),
  }
}

function draftFrom(snapshot: MemoryConfigSnapshot): SaveMemoryConfigInput {
  return {
    ...(snapshot.embedding === undefined ? {} : { embedding: { ...snapshot.embedding } }),
    ...(snapshot.extraction === undefined ? {} : { extraction: { ...snapshot.extraction } }),
    ...(snapshot.dbPath === undefined ? {} : { dbPath: snapshot.dbPath }),
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
