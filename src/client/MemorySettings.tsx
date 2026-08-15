import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconChevronDownOutline14, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryConfigSnapshot, MemoryEndpointConfig, SaveMemoryConfigInput } from '../types.ts'
import type { RoleClientApi } from './api.ts'

type EndpointKind = 'embedding' | 'extraction'
type EndpointField = 'endpoint' | 'model' | 'apiKey'

export type MemoryLocaleKey =
  | 'memory' | 'memorySummary' | 'memoryHint' | 'embedding' | 'extraction' | 'endpoint' | 'model' | 'apiKey'
  | 'save' | 'discard' | 'unsaved' | 'loading'
export type MemoryText = (key: MemoryLocaleKey) => string

interface MemorySettingsProps {
  readonly api: RoleClientApi
  readonly t: MemoryText
}

/** 记忆语义层配置卡片（settings.plugin.item）：与宿主插件卡片同构的可展开卡片。 */
export function MemorySettings({ api, t }: MemorySettingsProps) {
  const [config, setConfig] = useState<MemoryConfigSnapshot | null>(null)
  const [draft, setDraft] = useState<SaveMemoryConfigInput>({})
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const seed = (next: MemoryConfigSnapshot): SaveMemoryConfigInput => ({
    ...(next.embedding === undefined ? {} : { embedding: { ...next.embedding } }),
    ...(next.extraction === undefined ? {} : { extraction: { ...next.extraction } }),
  })

  const load = useCallback(() => {
    setError(null)
    void api.memoryConfig().then(next => {
      setConfig(next)
      setDraft(seed(next))
    }, cause => { setError(messageOf(cause)) })
  }, [api])

  useEffect(load, [load])

  const dirty = useMemo(() => config !== null && (endpointDirty(config.embedding, draft.embedding) || endpointDirty(config.extraction, draft.extraction)), [config, draft])

  const setEndpointField = (kind: EndpointKind, field: EndpointField, value: string) => {
    setDraft(current => {
      const endpoint = current[kind] ?? { endpoint: '', model: '' }
      return { ...current, [kind]: { ...endpoint, [field]: value } }
    })
  }

  const discard = () => {
    if (config === null || busy) return
    setDraft(seed(config))
    setError(null)
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const input: SaveMemoryConfigInput = {
        ...(draft.embedding?.endpoint.trim() ? { embedding: cleanEndpoint(draft.embedding) } : {}),
        ...(draft.extraction?.endpoint.trim() ? { extraction: cleanEndpoint(draft.extraction) } : {}),
      }
      const next = await api.saveMemoryConfig(input)
      setConfig(next)
      setDraft(seed(next))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={open ? 'shiori-role-memory-card shiori-role-memory-card--open' : 'shiori-role-memory-card'}>
      <button
        type="button"
        className="shiori-role-memory-card__header"
        aria-expanded={open}
        aria-label={t('memory')}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className="shiori-role-memory-card__head">
          <span className="shiori-role-memory-card__name">{t('memory')}</span>
          <span className="shiori-role-memory-card__description">{t('memorySummary')}</span>
        </span>
        {dirty ? <span className="shiori-role-memory-card__pending">{t('unsaved')}</span> : null}
        <IconChevronDownOutline14 className="shiori-role-memory-card__chevron" />
      </button>
      {open ? (
        <div className="shiori-role-memory-card__body">
          <p className="shiori-role-memory-card__hint">{t('memoryHint')}</p>
          {config === null && error === null ? <p className="shiori-role-memory-card__status">{t('loading')}</p> : null}
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
          {error === null ? null : <p role="alert" className="shiori-role-memory-card__failed">{error}</p>}
          <div className="shiori-role-memory-card__footer">
            <button type="button" className="shiori-role-memory-card__discard" disabled={!dirty || busy} onClick={discard}>{t('discard')}</button>
            <button type="button" className="shiori-role-memory-card__save" disabled={!dirty || busy} onClick={() => { void save() }}>{t('save')}</button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

function endpointDirty(stored: MemoryEndpointConfig | undefined, staged: MemoryEndpointConfig | undefined): boolean {
  if (stored === undefined) return staged?.endpoint.trim() !== '' || staged?.model.trim() !== '' || staged?.apiKey?.trim() !== ''
  if (staged === undefined) return false
  return staged.endpoint.trim() !== stored.endpoint.trim()
    || staged.model.trim() !== stored.model.trim()
    || (staged.apiKey?.trim() ?? '') !== (stored.apiKey?.trim() ?? '')
}

function cleanEndpoint(endpoint: MemoryEndpointConfig): MemoryEndpointConfig {
  return {
    endpoint: endpoint.endpoint.trim(),
    model: endpoint.model.trim(),
    ...(endpoint.apiKey?.trim() ? { apiKey: endpoint.apiKey.trim() } : {}),
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
