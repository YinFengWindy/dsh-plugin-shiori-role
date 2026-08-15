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
import { MemorySettings, type MemoryLocaleKey } from './MemorySettings.tsx'
import { ROLE_STYLES } from './styles.ts'

const NS = 'shiori.role'

const dictionaries = {
  en: {
    tab: 'Roles', loading: 'Loading...', create: 'Create role', createTitle: 'Create role', editTitle: 'Edit role', close: 'Close', delete: 'Delete', cancel: 'Cancel', save: 'Save', name: 'Name', introduction: 'Introduction', systemPrompt: 'System Prompt', avatar: 'Avatar', portrait: 'Standing illustration', assets: 'Asset library', background: 'Background', currentBackground: 'Current chat background', setBackground: 'Set as background', removeBackground: 'Remove background', backgroundHint: 'Used as the chat background in conversations with this role.', fixedRole: 'This session role is fixed', chooseRole: 'Choose role',
    memory: 'Memory', memorySummary: 'Semantic memory endpoints for roles.', memoryHint: 'Embedding enables vector retrieval, deduplication, and retiring superseded memories; extraction saves memories after each turn. Leave an endpoint empty to disable it.', embedding: 'Embedding', extraction: 'Extraction', endpoint: 'Endpoint', model: 'Model', apiKey: 'API Key', discard: 'Discard', unsaved: 'Unsaved',
  },
  zh: {
    tab: '角色', loading: '加载中...', create: '创建角色', createTitle: '创建角色', editTitle: '编辑角色', close: '关闭', delete: '删除', cancel: '取消', save: '保存', name: '名称', introduction: '简介', systemPrompt: 'System Prompt', avatar: '头像', portrait: '立绘', assets: '素材库', background: '聊天背景', currentBackground: '当前聊天背景', setBackground: '设为背景', removeBackground: '移除背景', backgroundHint: '使用该角色的会话会以此图为聊天背景。', fixedRole: '当前会话角色已固定', chooseRole: '选择角色',
    memory: '记忆', memorySummary: '角色的语义记忆层端点。', memoryHint: 'embedding 用于向量检索、自动去重与旧记忆淘汰；extraction 用于每轮对话后的记忆抽取。留空即禁用。', embedding: 'Embedding 端点', extraction: '抽取端点', endpoint: 'Endpoint', model: 'Model', apiKey: 'API Key', discard: '放弃修改', unsaved: '未保存',
  },
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'shiori.role': keyof typeof dictionaries.en
  }
}

/** settings.plugin.item 卡片 slot（宿主 ui-settings-plugins 的 ConfigurablePluginsTab 渲染）。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.plugin.item': {
      kind: 'list'
      scope: 'root'
      owner: { children?: never }
    }
  }
}

interface ShioriRoleRemote {
  catalogSnapshot(): ReturnType<ClientContext['remote']['shioriRole']['catalogSnapshot']>
  saveRole(input: Parameters<ClientContext['remote']['shioriRole']['saveRole']>[0]): ReturnType<ClientContext['remote']['shioriRole']['saveRole']>
  deleteRole(roleId: string): ReturnType<ClientContext['remote']['shioriRole']['deleteRole']>
  uploadAsset(input: Parameters<ClientContext['remote']['shioriRole']['uploadAsset']>[0]): ReturnType<ClientContext['remote']['shioriRole']['uploadAsset']>
  removeAsset(assetId: string): ReturnType<ClientContext['remote']['shioriRole']['removeAsset']>
  assetData(assetId: string): ReturnType<ClientContext['remote']['shioriRole']['assetData']>
  selectThemeBackground(input: Parameters<ClientContext['remote']['shioriRole']['selectThemeBackground']>[0]): ReturnType<ClientContext['remote']['shioriRole']['selectThemeBackground']>
  clearThemeBackground(roleId: string): ReturnType<ClientContext['remote']['shioriRole']['clearThemeBackground']>
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
    selectBackground: input => mutateCatalog(roleRemote.selectThemeBackground(input)),
    clearBackground: roleId => mutateCatalog(roleRemote.clearThemeBackground(roleId)),
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
  const roleText = ctx.locale.bind(NS) as (key: RoleLocaleKey) => string
  const memoryText = ctx.locale.bind(NS) as (key: MemoryLocaleKey) => string
  const style = document.createElement('style')
  style.dataset.shioriRole = 'styles'
  style.textContent = ROLE_STYLES
  document.head.append(style)

  const disposeTab = await ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'shiori-roles',
    order: 20,
    label: () => roleText('tab'),
    locale: NS,
    inject: () => ({ api, t: roleText }),
  }, RoleSettings))
  const disposeMemoryCard = await ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'shiori-role-memory',
    order: 10,
    locale: NS,
    inject: () => ({ api, t: memoryText }),
  }, MemorySettings))
  const disposeSelector = await ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'shiori-role-selector',
    order: 40,
    locale: NS,
    inject: () => ({ api, t: roleText }),
  }, RoleSelector))

  return async () => {
    disposeSelector()
    disposeMemoryCard()
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
