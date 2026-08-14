import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import remote from '../remote.ts'
import type { RoleClientApi } from './api.ts'
import { RoleSelector } from './RoleSelector.tsx'
import { RoleSettings, type RoleLocaleKey } from './RoleSettings.tsx'
import { ROLE_STYLES } from './styles.ts'

const NS = 'shiori.role'

const dictionaries = {
  en: {
    tab: 'Roles', loading: 'Loading...', create: 'Create role', createTitle: 'Create role', editTitle: 'Edit role', close: 'Close', delete: 'Delete', cancel: 'Cancel', save: 'Save', name: 'Name', introduction: 'Introduction', systemPrompt: 'System Prompt', avatar: 'Avatar', portrait: 'Standing illustration', assets: 'Asset library', fixedRole: 'This session role is fixed', chooseRole: 'Choose role',
    memory: 'Memory', memoryHint: 'Semantic memory endpoints. Embedding powers vector retrieval and automatic supersede; extraction powers post-turn memory extraction. Leave an endpoint empty to disable it.', embedding: 'Embedding', extraction: 'Extraction', endpoint: 'Endpoint', model: 'Model', apiKey: 'API Key', dbPath: 'Database path (optional)', saveMemory: 'Save memory config', memorySaved: 'Saved and applied.', memoryError: 'Failed to save memory config.',
  },
  zh: {
    tab: '角色', loading: '加载中...', create: '创建角色', createTitle: '创建角色', editTitle: '编辑角色', close: '关闭', delete: '删除', cancel: '取消', save: '保存', name: '名称', introduction: '简介', systemPrompt: 'System Prompt', avatar: '头像', portrait: '立绘', assets: '素材库', fixedRole: '当前会话角色已固定', chooseRole: '选择角色',
    memory: '记忆', memoryHint: '语义记忆层端点：embedding 用于向量检索与自动去重退休，extraction 用于回合后抽取。留空即禁用。', embedding: 'Embedding 端点', extraction: '抽取端点', endpoint: 'Endpoint', model: 'Model', apiKey: 'API Key', dbPath: '数据库路径（可选）', saveMemory: '保存记忆配置', memorySaved: '已保存并立即生效。', memoryError: '记忆配置保存失败。',
  },
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'shiori.role': keyof typeof dictionaries.en
  }
}

interface ShioriRoleRemote {
  catalogSnapshot(): ReturnType<ClientContext['remote']['shioriRole']['catalogSnapshot']>
  saveRole(input: Parameters<ClientContext['remote']['shioriRole']['saveRole']>[0]): ReturnType<ClientContext['remote']['shioriRole']['saveRole']>
  deleteRole(roleId: string): ReturnType<ClientContext['remote']['shioriRole']['deleteRole']>
  uploadAsset(input: Parameters<ClientContext['remote']['shioriRole']['uploadAsset']>[0]): ReturnType<ClientContext['remote']['shioriRole']['uploadAsset']>
  removeAsset(assetId: string): ReturnType<ClientContext['remote']['shioriRole']['removeAsset']>
  assetData(assetId: string): ReturnType<ClientContext['remote']['shioriRole']['assetData']>
  sessionSnapshot(sessionId: string): ReturnType<ClientContext['remote']['shioriRole']['sessionSnapshot']>
  stageSessionRole(sessionId: string, roleId: string): ReturnType<ClientContext['remote']['shioriRole']['stageSessionRole']>
  memoryConfigSnapshot(): ReturnType<ClientContext['remote']['shioriRole']['memoryConfigSnapshot']>
  saveMemoryConfig(input: Parameters<ClientContext['remote']['shioriRole']['saveMemoryConfig']>[0]): ReturnType<ClientContext['remote']['shioriRole']['saveMemoryConfig']>
}

export const inject = ['slots', 'locale', 'remote', 'theme']

/** Mount Remote, role management, composer binding, and role-owned theme layers. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(remote)
  const roleRemote = ctx.get('remote.shioriRole') as ShioriRoleRemote | undefined
  if (roleRemote === undefined) {
    await disposeRemote()
    throw new Error('shiori-role: Remote namespace did not start')
  }
  const catalogListeners = new Set<() => void>()
  const mutateCatalog = async (request: ReturnType<ShioriRoleRemote['saveRole']>) => {
    const snapshot = await unwrap(request)
    for (const listener of catalogListeners) listener()
    return snapshot
  }
  const api: RoleClientApi = {
    catalog: () => unwrap(roleRemote.catalogSnapshot()),
    saveRole: input => mutateCatalog(roleRemote.saveRole(input)),
    deleteRole: roleId => mutateCatalog(roleRemote.deleteRole(roleId)),
    uploadAsset: input => mutateCatalog(roleRemote.uploadAsset(input)),
    removeAsset: assetId => mutateCatalog(roleRemote.removeAsset(assetId)),
    assetData: assetId => unwrap(roleRemote.assetData(assetId)),
    session: sessionId => unwrap(roleRemote.sessionSnapshot(sessionId)),
    stage: (sessionId, roleId) => unwrap(roleRemote.stageSessionRole(sessionId, roleId)),
    memoryConfig: () => unwrap(roleRemote.memoryConfigSnapshot()),
    saveMemoryConfig: input => unwrap(roleRemote.saveMemoryConfig(input)),
    subscribeCatalog: listener => {
      catalogListeners.add(listener)
      return () => { catalogListeners.delete(listener) }
    },
  }
  const disposeLocale = ctx.locale.register(NS, dictionaries)
  const t = ctx.locale.bind(NS) as (key: RoleLocaleKey) => string
  const style = document.createElement('style')
  style.dataset.shioriRole = 'styles'
  style.textContent = ROLE_STYLES
  document.head.append(style)

  const disposeTab = await ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'shiori-roles',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: () => ({ api, t }),
  }, RoleSettings))
  const disposeSelector = await ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'shiori-role-selector',
    order: 40,
    locale: NS,
    inject: () => ({ api, ctx, t }),
  }, RoleSelector))

  return async () => {
    disposeSelector()
    disposeTab()
    style.remove()
    document.documentElement.classList.remove('shiori-role-theme')
    document.documentElement.style.removeProperty('--shiori-role-art')
    document.documentElement.style.removeProperty('--shiori-role-overlay')
    document.documentElement.style.removeProperty('--shiori-role-workspace-overlay')
    disposeLocale()
    await disposeRemote()
  }
}

async function unwrap<T>(request: Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
