import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { PERSONA_ORDER, PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import {
  shioriRoleDomainSpec,
  type PendingSessionRoleRecord,
  type RoleAssetRecord,
  type RoleCatalogRecord,
  type RoleRecord,
  type SessionRoleRecord,
  type StoredRoleMemoryRecord,
  type WorkspaceRoleRecord,
} from './spec.ts'
import { apply as applyRolePlugin, type Config as RolePluginConfig } from './role-plugin.ts'
import type {
  RoleAssetData,
  RoleAssetPurpose,
  RoleAssetView,
  RoleCatalogSnapshot,
  SaveRoleInput,
  SessionRoleSnapshot,
  ShioriRoleDefinition,
  ShioriRoleView,
  UploadRoleAssetInput,
  WorkspaceRoleSnapshot,
} from './types.ts'
import type { RoleMemoryScope } from './memory-contract.ts'
import { DuplicateRoleError, UnknownRoleError } from './registry.ts'
import { applyMemoryTools, ShioriMemoryService } from './memory.ts'
import { WorkspaceMemoryTable } from './file-memory-table.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    shioriRole: ShioriRoleService
  }
}

const CATALOG_MARKER = 'initialized'
const PRIMARY_ASSET_PURPOSES = new Set<RoleAssetPurpose>(['avatar', 'portrait', 'theme_background'])

/** Service configuration. Roles are imported once as editable catalog seeds. */
export interface Config {
  readonly roles: readonly ShioriRoleDefinition[]
}

/** Durable role catalog, session binding, attachment, and role-memory service. */
export class ShioriRoleService extends TypertRemoteService {
  static inject = ['storageDomain', 'workspaceRegistry', 'attachments']

  private domain?: Domain<typeof shioriRoleDomainSpec>
  private workspaceTable?: KvTable<string, WorkspaceRoleRecord>
  private sessionTable?: KvTable<SessionIdType, SessionRoleRecord>
  private pendingTable?: KvTable<SessionIdType, PendingSessionRoleRecord>
  private roleTable?: KvTable<string, RoleRecord>
  private assetTable?: KvTable<string, RoleAssetRecord>
  private catalogTable?: KvTable<string, RoleCatalogRecord>
  private memoryTable?: KvTable<string, StoredRoleMemoryRecord>
  private memoryService?: ShioriMemoryService
  private readonly workspaceMemoryServices = new Map<string, ShioriMemoryService>()
  private readonly boundRoles = new Map<SessionIdType, string>()

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'shioriRole')
  }

  protected async [Service.init](): Promise<void> {
    this.domain = await this.ctx.storageDomain.open(shioriRoleDomainSpec)
    this.ctx.effect(() => () => { void this.domain?.close() }, 'shioriRole.domainClose')
    this.workspaceTable = this.domain.table('workspace_roles')
    this.sessionTable = this.domain.table('session_roles')
    this.pendingTable = this.domain.table('pending_session_roles')
    this.roleTable = this.domain.table('roles')
    this.assetTable = this.domain.table('role_assets')
    this.catalogTable = this.domain.table('catalog')
    this.memoryTable = this.domain.table('memories')
    await this.initializeCatalog()
    this.memoryService = new ShioriMemoryService(this.memoryTable)
    this.ctx.inject(['agents', 'systemPrompt', 'tools'], (runtimeCtx) => {
      for (const agent of runtimeCtx.agents.list()) this.mountAgent(agent)
      runtimeCtx.on('agent/created', ({ agent }) => { this.mountAgent(agent) })
      runtimeCtx.on('agent/disposed', ({ agent }) => { this.boundRoles.delete(agent.session.id) })
    })
  }

  /** List current durable role definitions. */
  list(): readonly ShioriRoleDefinition[] {
    return [...this.requireRoleTable().entries()]
      .filter(([, role]) => role.deletedAt === undefined)
      .map(([id, role]) => ({ id, ...role }))
  }

  /** Resolve a current durable role by id. */
  get(roleId: string): ShioriRoleDefinition | undefined {
    const role = this.requireRoleTable().get(roleId)
    return role === undefined ? undefined : { id: roleId, ...role }
  }

  /** Read all editable roles and their attachment references. */
  @Remote('catalogSnapshot')
  async catalogSnapshot(): Promise<RoleCatalogSnapshot> {
    return { roles: this.roleViews() }
  }

  /** Create or update one role. */
  @Remote('saveRole')
  async saveRole(input: SaveRoleInput): Promise<RoleCatalogSnapshot> {
    const name = input.name.trim()
    const introduction = input.introduction.trim()
    const prompt = input.prompt.trim()
    if (!name) throw new Error('shiori-role: role name must not be empty')
    if (!prompt) throw new Error('shiori-role: System Prompt must not be empty')
    const id = input.id?.trim() || crypto.randomUUID()
    const current = this.requireRoleTable().get(id)
    const now = new Date().toISOString()
    await this.requireRoleTable().put(id, {
      name,
      introduction,
      prompt,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    })
    return this.catalogSnapshot()
  }

  /** Delete an unbound role, its assets, and repair mutable role references. */
  @Remote('deleteRole')
  async deleteRole(roleId: string): Promise<RoleCatalogSnapshot> {
    const current = this.requireRoleTable().get(roleId)
    if (current === undefined) throw new UnknownRoleError(roleId)
    const usedBySession = [...this.requireSessionTable().entries()].some(([, row]) => row.roleId === roleId)
    const replacement = this.roleViews().find(role => role.id !== roleId)
    const updatedAt = new Date().toISOString()
    if (usedBySession) {
      // Preserve immutable session snapshots while hiding the role from
      // mutable catalogs and future-session selectors.
      await this.requireRoleTable().put(roleId, { ...current, deletedAt: updatedAt })
    } else {
      await this.requireRoleTable().delete(roleId)
      for (const [key, row] of this.requireAssetTable().entries()) {
        if (row.roleId === roleId) await this.requireAssetTable().delete(key)
      }
      for (const [key, row] of this.requireMemoryTable().entries()) {
        if (row.roleId === roleId) await this.requireMemoryTable().delete(key)
      }
      for (const memory of this.workspaceMemoryServices.values()) await memory.forgetRole(roleId)
    }
    for (const [key, row] of this.requirePendingTable().entries()) {
      if (row.roleId !== roleId) continue
      if (replacement === undefined) await this.requirePendingTable().delete(key)
      else await this.requirePendingTable().put(key, { roleId: replacement.id, updatedAt })
    }
    for (const [key, row] of this.requireWorkspaceTable().entries()) {
      if (row.roleId !== roleId) continue
      if (replacement === undefined) await this.requireWorkspaceTable().delete(key)
      else await this.requireWorkspaceTable().put(key, { roleId: replacement.id, updatedAt })
    }
    return this.catalogSnapshot()
  }

  /** Validate and save a role image through Harness attachment storage. */
  @Remote('uploadAsset')
  async uploadAsset(input: UploadRoleAssetInput): Promise<RoleCatalogSnapshot> {
    this.requireActiveRole(input.roleId)
    const attachment = await this.ctx.attachments.saveImage({
      data: decodeBase64(input.data),
      mediaType: input.mediaType,
      ...(input.name === undefined ? {} : { name: input.name }),
    })
    if (PRIMARY_ASSET_PURPOSES.has(input.purpose)) {
      for (const [key, row] of this.requireAssetTable().entries()) {
        if (row.roleId === input.roleId && row.purpose === input.purpose) {
          await this.requireAssetTable().delete(key)
        }
      }
    }
    await this.requireAssetTable().put(crypto.randomUUID(), {
      roleId: input.roleId,
      purpose: input.purpose,
      attachment,
      createdAt: new Date().toISOString(),
    })
    return this.catalogSnapshot()
  }

  /** Remove one role-owned image reference. */
  @Remote('removeAsset')
  async removeAsset(assetId: string): Promise<RoleCatalogSnapshot> {
    await this.requireAssetTable().delete(assetId)
    return this.catalogSnapshot()
  }

  /** Read verified attachment bytes for browser display. */
  @Remote('assetData')
  async assetData(assetId: string): Promise<RoleAssetData> {
    const record = this.requireAssetTable().get(assetId)
    if (record === undefined) throw new Error(`shiori-role: unknown asset '${assetId}'`)
    const stored = await this.ctx.attachments.readImage(record.attachment)
    return {
      asset: { id: assetId, ...record },
      data: encodeBase64(stored.data),
    }
  }

  /** Read the client-safe role catalog and default selection for a workspace. */
  @Remote('snapshot')
  async snapshot(workspaceId: string): Promise<WorkspaceRoleSnapshot> {
    const activeRoleId = this.requireWorkspaceTable().get(workspaceId)?.roleId
    return { workspaceId, roles: this.roleViews(), ...(activeRoleId === undefined ? {} : { activeRoleId }) }
  }

  /** Change the fallback role used by future blank sessions in one workspace. */
  @Remote('select')
  async selectRemote(workspaceId: string, roleId: string): Promise<WorkspaceRoleSnapshot> {
    await this.select(workspaceId as WorkspaceId, roleId)
    return this.snapshot(workspaceId)
  }

  /** Read pending or immutable binding state for a session. */
  @Remote('sessionSnapshot')
  async sessionSnapshot(rawSessionId: string): Promise<SessionRoleSnapshot> {
    const sessionId = SessionId(rawSessionId)
    const committed = this.requireSessionTable().get(sessionId)
    const pending = committed === undefined ? this.requirePendingTable().get(sessionId)?.roleId : undefined
    const blank = this.isLiveBlankSession(sessionId)
    return {
      sessionId: rawSessionId,
      roles: this.roleViews(committed?.roleId),
      ...(committed === undefined ? {} : { roleId: committed.roleId }),
      ...(pending === undefined ? {} : { pendingRoleId: pending }),
      locked: committed !== undefined && (committed.bindingVersion >= 2 || !blank),
    }
  }

  /** Stage a role for a blank session; an existing binding is immutable. */
  @Remote('stageSessionRole')
  async stageSessionRole(rawSessionId: string, roleId: string): Promise<SessionRoleSnapshot> {
    const sessionId = SessionId(rawSessionId)
    this.requireActiveRole(roleId)
    const stored = this.requireSessionTable().get(sessionId)
    let committed = stored?.roleId ?? this.boundRoles.get(sessionId)
    if (stored !== undefined && stored.bindingVersion < 2 && this.isLiveBlankSession(sessionId)) {
      // Version-one bound workspace defaults at blank-Agent creation. A live
      // empty log proves that no model output used that identity, so it is
      // safe to migrate the row back to a mutable pending selection.
      await this.requireSessionTable().delete(sessionId)
      this.boundRoles.delete(sessionId)
      committed = undefined
    }
    if (committed !== undefined) {
      if (committed !== roleId) throw new Error(`shiori-role: session '${rawSessionId}' is already bound to '${committed}'`)
      return this.sessionSnapshot(rawSessionId)
    }
    await this.requirePendingTable().put(sessionId, { roleId, updatedAt: new Date().toISOString() })
    return this.sessionSnapshot(rawSessionId)
  }

  /** Set the workspace fallback role. */
  async select(workspaceId: WorkspaceId, roleId: string): Promise<void> {
    this.requireActiveRole(roleId)
    await this.requireWorkspaceTable().put(String(workspaceId), { roleId, updatedAt: new Date().toISOString() })
  }

  /** Read the workspace fallback role. */
  async active(workspaceId: WorkspaceId): Promise<ShioriRoleDefinition | undefined> {
    const roleId = this.requireWorkspaceTable().get(String(workspaceId))?.roleId
    return roleId === undefined ? undefined : this.requireActiveRole(roleId)
  }

  /** Compose a fixed role into an unpublished Agent scope. */
  async compose(agentCtx: Context, roleId?: string): Promise<ShioriRoleDefinition> {
    const agent = scopeOf(agentCtx) as Agent | undefined
    if (agent === undefined || agent.session === undefined) throw new Error('shiori-role: compose requires an Agent scope')
    const sessionRoleId = this.requireSessionTable().get(agent.session.id)?.roleId
    if (sessionRoleId !== undefined && roleId !== undefined && roleId !== sessionRoleId) {
      throw new Error(`shiori-role: session '${agent.id}' is already bound to '${sessionRoleId}'`)
    }
    const pendingRoleId = sessionRoleId === undefined ? this.requirePendingTable().get(agent.session.id)?.roleId : undefined
    const workspaceRole = sessionRoleId === undefined && pendingRoleId === undefined ? await this.resolveWorkspaceRole(agent) : undefined
    const resolved = this.requireRole(roleId ?? sessionRoleId ?? pendingRoleId ?? workspaceRole?.id ?? '')
    if (sessionRoleId === undefined) await this.commitSessionRole(agent.session.id, resolved.id)
    await agentCtx.plugin(applyRolePlugin, resolved satisfies RolePluginConfig)
    const memoryPlugin = Object.assign(
      (inner: Context) => applyMemoryTools(inner, this.memoryForAgent(agent), resolved.id),
      { inject: ['systemPrompt', 'tools'] },
    )
    await agentCtx.plugin(memoryPlugin)
    this.boundRoles.set(agent.session.id, resolved.id)
    return resolved
  }

  /** Access role-scoped memory after initialization. */
  memory(): ShioriMemoryService {
    return this.requireMemoryService()
  }

  private async initializeCatalog(): Promise<void> {
    if (this.requireCatalogTable().get(CATALOG_MARKER) !== undefined) return
    const seen = new Set<string>()
    const now = new Date().toISOString()
    for (const seed of this.config.roles) {
      const id = seed.id.trim()
      if (!id) throw new Error('Shiori role id must not be empty')
      if (seen.has(id)) throw new DuplicateRoleError(id)
      seen.add(id)
      const name = seed.name.trim()
      const prompt = seed.prompt.trim()
      if (!name) throw new Error(`Shiori role '${id}' name must not be empty`)
      if (!prompt) throw new Error(`Shiori role '${id}' prompt must not be empty`)
      await this.requireRoleTable().put(id, {
        name,
        introduction: seed.introduction?.trim() ?? '',
        prompt,
        createdAt: now,
        updatedAt: now,
      })
    }
    await this.requireCatalogTable().put(CATALOG_MARKER, { initializedAt: now })
  }

  private roleViews(includeRoleId?: string): ShioriRoleView[] {
    const assets = new Map<string, RoleAssetView[]>()
    for (const [id, record] of this.requireAssetTable().entries()) {
      const values = assets.get(record.roleId) ?? []
      values.push({ id, ...record })
      assets.set(record.roleId, values)
    }
    return [...this.requireRoleTable().entries()]
      .filter(([id, role]) => role.deletedAt === undefined || id === includeRoleId)
      .map(([id, role]) => ({ id, ...role, assets: assets.get(id) ?? [] }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  private requireRole(roleId: string): ShioriRoleDefinition {
    const role = this.get(roleId)
    if (role === undefined) throw new UnknownRoleError(roleId)
    return role
  }

  private requireActiveRole(roleId: string): ShioriRoleDefinition {
    const role = this.requireRole(roleId)
    if (this.requireRoleTable().get(roleId)?.deletedAt !== undefined) throw new UnknownRoleError(roleId)
    return role
  }

  private async resolveWorkspaceRole(agent: Agent): Promise<ShioriRoleDefinition | undefined> {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return undefined
    const workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd)
    return workspace === undefined ? undefined : this.active(workspace.id)
  }

  /** Mount a dynamic role boundary; a blank session commits only on first prompt assembly. */
  private mountAgent(agent: Agent): void {
    if (this.boundRoles.has(agent.session.id)) return
    const workspace = agent.session.header.cwd === undefined
      ? undefined
      : this.ctx.workspaceRegistry.list().find(item => item.path === agent.session.header.cwd)
    let bindingReady = Promise.resolve()
    let bindingStarted = false
    const resolveRole = (): ShioriRoleDefinition => {
      const stored = this.requireSessionTable().get(agent.session.id)
      const pending = stored === undefined ? this.requirePendingTable().get(agent.session.id) : undefined
      const selected = stored === undefined && pending === undefined && workspace !== undefined
        ? this.requireWorkspaceTable().get(String(workspace.id))
        : undefined
      const role = this.requireRole(stored?.roleId ?? pending?.roleId ?? selected?.roleId ?? '')
      if (stored === undefined && !bindingStarted) {
        bindingStarted = true
        bindingReady = this.commitSessionRole(agent.session.id, role.id)
        void bindingReady.catch(error => {
          this.ctx.logger.error(`shiori-role: failed to persist role for session '${String(agent.session.id)}': ${String(error)}`)
        })
      }
      this.boundRoles.set(agent.session.id, role.id)
      return role
    }
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      await bindingReady
      return next()
    })
    agent.ctx.systemPrompt.section({
      name: PERSONA_SECTION,
      order: PERSONA_ORDER,
      text: () => resolveRole().prompt,
    })
    applyMemoryTools(agent.ctx, this.memoryForAgent(agent), () => {
      const role = resolveRole()
      return { roleId: role.id, sessionKey: String(agent.session.id) } satisfies RoleMemoryScope
    })
    const stored = this.requireSessionTable().get(agent.session.id)
    if (stored !== undefined) this.boundRoles.set(agent.session.id, stored.roleId)
  }

  private async commitSessionRole(sessionId: SessionIdType, roleId: string): Promise<void> {
    await this.requireSessionTable().put(sessionId, { roleId, boundAt: new Date().toISOString(), bindingVersion: 2 })
    await this.requirePendingTable().delete(sessionId)
  }

  private isLiveBlankSession(sessionId: SessionIdType): boolean {
    const agent = this.ctx.get('agents')?.get(sessionId)
    if (agent === undefined) return false
    return !agent.session.events.some(event => event.type === 'user/message' || event.type === 'turn/start')
  }

  private requireWorkspaceTable(): KvTable<string, WorkspaceRoleRecord> {
    if (this.workspaceTable === undefined) throw new Error('shiori-role: service is not started')
    return this.workspaceTable
  }

  private requireSessionTable(): KvTable<SessionIdType, SessionRoleRecord> {
    if (this.sessionTable === undefined) throw new Error('shiori-role: service is not started')
    return this.sessionTable
  }

  private requirePendingTable(): KvTable<SessionIdType, PendingSessionRoleRecord> {
    if (this.pendingTable === undefined) throw new Error('shiori-role: service is not started')
    return this.pendingTable
  }

  private requireRoleTable(): KvTable<string, RoleRecord> {
    if (this.roleTable === undefined) throw new Error('shiori-role: service is not started')
    return this.roleTable
  }

  private requireAssetTable(): KvTable<string, RoleAssetRecord> {
    if (this.assetTable === undefined) throw new Error('shiori-role: service is not started')
    return this.assetTable
  }

  private requireCatalogTable(): KvTable<string, RoleCatalogRecord> {
    if (this.catalogTable === undefined) throw new Error('shiori-role: service is not started')
    return this.catalogTable
  }

  private requireMemoryService(): ShioriMemoryService {
    if (this.memoryService === undefined) throw new Error('shiori-role: service is not started')
    return this.memoryService
  }

  private memoryForAgent(agent: Agent): ShioriMemoryService {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return this.requireMemoryService()
    const existing = this.workspaceMemoryServices.get(cwd)
    if (existing !== undefined) return existing
    const service = new ShioriMemoryService(new WorkspaceMemoryTable(cwd))
    this.workspaceMemoryServices.set(cwd, service)
    return service
  }

  private requireMemoryTable(): KvTable<string, StoredRoleMemoryRecord> {
    if (this.memoryTable === undefined) throw new Error('shiori-role: service is not started')
    return this.memoryTable
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  if (!value || encodeBase64(Uint8Array.from(binary, character => character.charCodeAt(0))) !== value) {
    throw new Error('shiori-role: image payload must be canonical base64')
  }
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function encodeBase64(data: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export type { ImageMediaType }
export { DuplicateRoleError, UnknownRoleError }
