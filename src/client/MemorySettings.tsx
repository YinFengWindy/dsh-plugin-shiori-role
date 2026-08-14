import { useCallback, useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryConfigSnapshot, MemoryEndpointConfig, SaveMemoryConfigInput } from '../types.ts'
import type { RoleClientApi } from './api.ts'

type EndpointKind = 'embedding' | 'extraction'
type EndpointField = 'endpoint' | 'model' | 'apiKey'

export type MemoryLocaleKey =
  | 'memory' | 'memoryHint' | 'embedding' | 'extraction' | 'endpoint' | 'model' | 'apiKey'
  | 'saveMemory' | 'memorySaved' | 'memoryError' | 'loading'
export type MemoryText = (key: MemoryLocaleKey) => string

interface MemorySettingsProps {
  readonly api: RoleClientApi
  readonly t: MemoryText
}

/** 记忆语义层配置卡片（settings.plugin.item）：embedding / extraction 端点，留空即禁用。 */
export function MemorySettings({ api, t }: MemorySettingsProps) {
  const [config, setConfig] = useState<MemoryConfigSnapshot | null>(null)
  const [draft, setDraft] = useState<SaveMemoryConfigInput>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = useCallback(() => {
    setError(null)
    void api.memoryConfig().then(next => {
      setConfig(next)
      setDraft({
        ...(next.embedding === undefined ? {} : { embedding: { ...next.embedding } }),
        ...(next.extraction === undefined ? {} : { extraction: { ...next.extraction } }),
      })
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
      }
      const next = await api.saveMemoryConfig(input)
      setConfig(next)
      setDraft({
        ...(next.embedding === undefined ? {} : { embedding: { ...next.embedding } }),
        ...(next.extraction === undefined ? {} : { extraction: { ...next.extraction } }),
      })
      setSaved(true)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="shiori-role-memory">
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

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
