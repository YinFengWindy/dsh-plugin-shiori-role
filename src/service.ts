import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { PERSONA_ORDER, PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import {
  shioriRoleDomainSpec,
  type MemoryConfigRecord,
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
  SelectThemeBackgroundInput,
  SessionRoleSnapshot,
  ShioriRoleDefinition,
  ShioriRoleView,
  UploadRoleAssetInput,
  WorkspaceRoleSnapshot,
  MemoryConfigSnapshot,
  MemoryEndpointConfig,
  SaveMemoryConfigInput,
} from './types.ts'
import type { RoleMemoryScope } from './memory-contract.ts'
import { DuplicateRoleError, UnknownRoleError } from './registry.ts'
import type { MemoryEmbeddingConfig, MemoryExtractionConfig } from './memory.ts'
import type { MemoryChatClient } from './memory-engine/llm.ts'
import { DefaultMemoryEngine } from './memory-engine/engine.ts'
import { ChatClient, Embedder } from './memory-engine/llm.ts'
import { HarnessMemoryChatClient, HarnessSemanticChatClient, resolveHarnessRoute } from './memory-engine/harness-chat.ts'
import { ShioriMemoryStore, resolveMemoryDbPath } from './memory-engine/store.ts'
import { resolveMemoryConfig } from './memory-engine/config.ts'
import { applyMemoryTools, type MemoryToolsEngine } from './memory-engine/tools.ts'
import { DEFAULT_SELF_MD, RoleFiles } from './role-files.ts'
import { RoleSelfMemory } from './self-memory.ts'
import { MarkdownMemory } from './markdown-memory.ts'
import { consolidateRecentContext, consolidateSemantics } from './semantic-consolidation.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

declare module '@deepseek-ai/cordis' {
  interface Context {
    shioriRole: ShioriRoleService
  }
}

const CATALOG_MARKER = 'initialized'
const CONFIG_KEY = 'config'
const PRIMARY_ASSET_PURPOSES = new Set<RoleAssetPurpose>(['avatar', 'portrait', 'theme_background'])
const MARKDOWN_MEMORY_CONTEXT_ORDER = 35

/** Service configuration. Roles are imported once as editable catalog seeds. */
export interface Config {
  readonly roles: readonly ShioriRoleDefinition[]
  /** Optional global DSH data root; each role owns its directory across DSH workspaces. */
  readonly memoryRoot?: string
  /** Optional embedding endpoint and post-turn extraction endpoint override. */
  readonly memory?: {
    readonly embedding?: MemoryEmbeddingConfig
    readonly extraction?: MemoryExtractionConfig
  }
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
  private memoryConfigTable?: KvTable<string, MemoryConfigRecord>
  private readonly roleFiles: RoleFiles
  private readonly selfMemory: RoleSelfMemory
  private readonly markdownMemory: MarkdownMemory
  private readonly memoryStores = new Map<string, ShioriMemoryStore>()
  private readonly memoryEngines = new Map<string, DefaultMemoryEngine>()
  private readonly memoryToolsEngine: MemoryToolsEngine = {
    query: request => this.requireMemoryEngine(scopeRoleId(request.scope)).query(request),
    mutate: request => this.requireMemoryEngine(scopeRoleId(request.scope)).mutate(request),
    contextText: scope => this.requireMemoryEngine(scopeRoleId(scope)).contextText(scope),
  }
  private readonly boundRoles = new Map<SessionIdType, string>()
  private readonly semanticJobs = new Set<string>()
  private readonly roleMaintenanceTails = new Map<string, Promise<void>>()
  private readonly selfSeedJobs = new Map<string, Promise<void>>()
  private readonly provisionalRoles = new Map<SessionIdType, string>()
  private readonly roleResolvers = new Map<SessionIdType, () => ShioriRoleDefinition | undefined>()
  private readonly roleContributionSessions = new Set<SessionIdType>()
  private readonly memoryToolSessions = new Set<SessionIdType>()
  private readonly deletedRoles = new Set<string>()

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'shioriRole')
    this.roleFiles = new RoleFiles(resolveMemoryRoot(config.memoryRoot))
    this.selfMemory = new RoleSelfMemory(this.roleFiles)
    this.markdownMemory = new MarkdownMemory(this.roleFiles)
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
    this.memoryConfigTable = this.domain.table('memory_config')
    await this.initializeCatalog()
    this.ctx.effect(() => () => {
      for (const store of this.memoryStores.values()) store.close()
      this.memoryStores.clear()
      this.memoryEngines.clear()
    }, 'shioriRole.memoryStoresClose')
    for (const role of this.list()) this.roleFiles.writeRoleDefinition(role)
    this.ctx.inject(['agents', 'systemPrompt', 'tools'], (runtimeCtx) => {
      for (const agent of runtimeCtx.agents.list()) this.mountAgent(agent)
      runtimeCtx.on('agent/created', ({ agent }) => { this.mountAgent(agent) })
      runtimeCtx.on('agent/disposed', ({ agent }) => {
        this.boundRoles.delete(agent.session.id)
        this.provisionalRoles.delete(agent.session.id)
        this.roleResolvers.delete(agent.session.id)
        this.roleContributionSessions.delete(agent.session.id)
        this.memoryToolSessions.delete(agent.session.id)
      })
      runtimeCtx.on('session/event', (session, event) => {
        if (event.type !== 'compaction/end' || event.data.error !== undefined) return
        const agent = runtimeCtx.agents.get(session.id)
        if (agent === undefined) return
        const summaryEvent = [...session.events].reverse().find(candidate =>
          candidate.type === 'compaction/summary' && candidate.data.compactionId === event.data.compactionId,
        )
        if (summaryEvent?.type !== 'compaction/summary') return
        const roleId = this.requireSessionTable().get(session.id)?.roleId ?? this.boundRoles.get(session.id)
        if (roleId === undefined) return
        if (this.deletedRoles.has(roleId)) return
        const jobKey = `${String(session.id)}:${String(event.data.compactionId)}`
        if (this.semanticJobs.has(jobKey)) return
        this.semanticJobs.add(jobKey)
        void this.enqueueRoleMaintenance(roleId, () => this.maintainCompactedMemory(agent, roleId, summaryEvent)).catch(error => {
          this.ctx.logger.error(`shiori-role: semantic consolidation failed for '${jobKey}': ${String(error)}`)
        }).finally(() => { this.semanticJobs.delete(jobKey) })
      })
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
    const role = { id, name, introduction, prompt, createdAt: current?.createdAt ?? now, updatedAt: now }
    this.roleFiles.writeRoleDefinition(role)
    return this.catalogSnapshot()
  }

  /** Physically delete a role and repair all remaining mutable references. */
  @Remote('deleteRole')
  async deleteRole(roleId: string): Promise<RoleCatalogSnapshot> {
    const current = this.requireRoleTable().get(roleId)
    if (current === undefined) throw new UnknownRoleError(roleId)
    const replacement = this.roleViews().find(role => role.id !== roleId)
    const updatedAt = new Date().toISOString()
    const attachmentIds = [...this.requireAssetTable().entries()]
      .filter(([, row]) => row.roleId === roleId)
      .map(([, row]) => String(row.attachment.attachmentId))
    this.deletedRoles.add(roleId)
    await Promise.all([
      this.roleMaintenanceTails.get(roleId)?.catch(() => undefined),
      this.selfSeedJobs.get(roleId)?.catch(() => undefined),
    ])
    await this.requireRoleTable().delete(roleId)
    for (const [key, row] of this.requireSessionTable().entries()) {
      if (row.roleId === roleId) await this.requireSessionTable().delete(key)
    }
    for (const [sessionId, role] of this.boundRoles.entries()) {
      if (role === roleId) this.boundRoles.delete(sessionId)
    }
    for (const [key, row] of this.requireAssetTable().entries()) {
      if (row.roleId === roleId) await this.requireAssetTable().delete(key)
    }
    this.collectOrphanAttachments(attachmentIds)
    for (const [key, row] of this.requireMemoryTable().entries()) {
      if (row.roleId === roleId) await this.requireMemoryTable().delete(key)
    }
    this.disposeRoleMemory(roleId)
    this.roleFiles.deleteRole(roleId)
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

  /** Promote one gallery asset to the role's single theme background (previous one returns to the gallery). */
  @Remote('selectThemeBackground')
  async selectThemeBackground(input: SelectThemeBackgroundInput): Promise<RoleCatalogSnapshot> {
    this.requireActiveRole(input.roleId)
    const asset = this.requireAssetTable().get(input.assetId)
    if (asset === undefined || asset.roleId !== input.roleId) throw new Error(`shiori-role: unknown asset '${input.assetId}'`)
    if (asset.purpose !== 'gallery') throw new Error('shiori-role: only gallery assets can become a theme background')
    for (const [key, row] of this.requireAssetTable().entries()) {
      if (row.roleId === input.roleId && row.purpose === 'theme_background') {
        await this.requireAssetTable().put(key, { ...row, purpose: 'gallery' })
      }
    }
    await this.requireAssetTable().put(input.assetId, { ...asset, purpose: 'theme_background' })
    return this.catalogSnapshot()
  }

  /** Return the role's theme background to the gallery. */
  @Remote('clearThemeBackground')
  async clearThemeBackground(roleId: string): Promise<RoleCatalogSnapshot> {
    this.requireActiveRole(roleId)
    for (const [key, row] of this.requireAssetTable().entries()) {
      if (row.roleId === roleId && row.purpose === 'theme_background') {
        await this.requireAssetTable().put(key, { ...row, purpose: 'gallery' })
      }
    }
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

  /** Read the effective memory configuration (KV override on top of startup config). */
  @Remote('memoryConfigSnapshot')
  async memoryConfigSnapshot(): Promise<MemoryConfigSnapshot> {
    return this.effectiveMemoryConfig()
  }

  /** Persist memory endpoints (embedding / extraction) and hot-apply them to the engine. */
  @Remote('saveMemoryConfig')
  async saveMemoryConfig(input: SaveMemoryConfigInput): Promise<MemoryConfigSnapshot> {
    const record: MemoryConfigRecord = {
      ...(input.embedding === undefined ? {} : { embedding: sanitizeEndpoint(input.embedding) }),
      ...(input.extraction === undefined ? {} : { extraction: sanitizeEndpoint(input.extraction) }),
      updatedAt: new Date().toISOString(),
    }
    await this.requireMemoryConfigTable().put(CONFIG_KEY, record)
    for (const engine of this.memoryEngines.values()) engine.updateLlm(
      record.embedding === undefined ? undefined : new Embedder(record.embedding),
      record.extraction === undefined ? undefined : new ChatClient(record.extraction),
    )
    return this.effectiveMemoryConfig()
  }

  /** KV 优先、启动 Config 兜底的当前记忆配置。 */
  private effectiveMemoryConfig(): MemoryConfigSnapshot {
    const stored = this.memoryConfigTable?.get(CONFIG_KEY)
    const startup = this.config.memory
    const embedding = stored?.embedding ?? startup?.embedding
    const extraction = stored?.extraction ?? startup?.extraction
    return {
      ...(embedding === undefined ? {} : { embedding }),
      ...(extraction === undefined ? {} : { extraction }),
      ...(stored?.updatedAt === undefined ? {} : { updatedAt: stored.updatedAt }),
    }
  }

  /** Read pending or immutable binding state for a session. */
  @Remote('sessionSnapshot')
  async sessionSnapshot(rawSessionId: string): Promise<SessionRoleSnapshot> {
    const sessionId = SessionId(rawSessionId)
    const committed = this.requireSessionTable().get(sessionId)
    const pending = committed === undefined ? this.requirePendingTable().get(sessionId)?.roleId : undefined
    return {
      sessionId: rawSessionId,
      roles: this.roleViews(committed?.roleId),
      ...(committed === undefined ? {} : { roleId: committed.roleId }),
      ...(pending === undefined ? {} : { pendingRoleId: pending }),
      locked: committed !== undefined,
    }
  }

  /** Stage a role for a blank session; an existing binding is immutable. */
  @Remote('stageSessionRole')
  async stageSessionRole(rawSessionId: string, roleId: string): Promise<SessionRoleSnapshot> {
    const sessionId = SessionId(rawSessionId)
    this.requireActiveRole(roleId)
    const stored = this.requireSessionTable().get(sessionId)
    const committed = stored?.roleId ?? this.boundRoles.get(sessionId)
    if (committed !== undefined) {
      if (committed !== roleId) throw new Error(`shiori-role: session '${rawSessionId}' is already bound to '${committed}'`)
      return this.sessionSnapshot(rawSessionId)
    }
    await this.requirePendingTable().put(sessionId, { roleId, updatedAt: new Date().toISOString() })
    const agent = this.ctx.get('agents')?.get(sessionId)
    if (agent !== undefined) this.ensureRoleContributions(agent)
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
  async compose(agentCtx: Context, roleId?: string): Promise<ShioriRoleDefinition | undefined> {
    const agent = scopeOf(agentCtx) as Agent | undefined
    if (agent === undefined || agent.session === undefined) throw new Error('shiori-role: compose requires an Agent scope')
    const sessionRoleId = this.requireSessionTable().get(agent.session.id)?.roleId
    if (sessionRoleId !== undefined && roleId !== undefined && roleId !== sessionRoleId) {
      throw new Error(`shiori-role: session '${agent.id}' is already bound to '${sessionRoleId}'`)
    }
    const pendingRoleId = sessionRoleId === undefined ? this.requirePendingTable().get(agent.session.id)?.roleId : undefined
    const workspaceRole = sessionRoleId === undefined && pendingRoleId === undefined ? await this.resolveWorkspaceRole(agent) : undefined
    const resolvedId = roleId ?? sessionRoleId ?? pendingRoleId ?? workspaceRole?.id
    if (resolvedId === undefined) return undefined
    const resolved = this.requireRole(resolvedId)
    if (sessionRoleId === undefined) await this.commitSessionRole(agent.session.id, resolved.id)
    await agentCtx.plugin(applyRolePlugin, resolved satisfies RolePluginConfig)
    const memoryPlugin = Object.assign(
      (inner: Context) => applyMemoryTools(inner, this.memoryToolsEngine, resolved.id),
      { inject: ['systemPrompt', 'tools'] },
    )
    await agentCtx.plugin(memoryPlugin)
    this.boundRoles.set(agent.session.id, resolved.id)
    return resolved
  }

  /** Access role memory after initialization. */
  memory(): DefaultMemoryEngine {
    const role = this.list()[0]
    if (role === undefined) throw new Error('shiori-role: no role is configured')
    return this.requireMemoryEngine(role.id)
  }

  private async initializeCatalog(): Promise<void> {
    if (this.requireCatalogTable().get(CATALOG_MARKER) === undefined) {
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
    for (const role of this.roleFiles.listRoleDefinitions()) {
      const existing = this.requireRoleTable().get(role.id)
      if (existing !== undefined) {
        if (
          existing.deletedAt === undefined
          && existing.name === role.name
          && existing.introduction === role.introduction
          && existing.prompt === role.prompt
        ) continue
        throw new DuplicateRoleError(role.id)
      }
      await this.requireRoleTable().put(role.id, {
        name: role.name,
        introduction: role.introduction,
        prompt: role.prompt,
        createdAt: role.createdAt,
        updatedAt: role.updatedAt,
      })
    }
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

  /** Mount a role boundary; blank sessions commit only when their first prompt is assembled. */
  private mountAgent(agent: Agent): void {
    if (this.boundRoles.has(agent.session.id)) return
    const runtimeParent = this.ctx.get('agents')?.list().find(candidate => this.ctx.get('agents')?.isOwnedBy(agent.id, candidate))
    const parentSessionId = agent.session.header.parentSession ?? runtimeParent?.session.id
    const parentAgent = parentSessionId === undefined ? undefined : this.ctx.get('agents')?.get(parentSessionId)
    const parentWorkspace = parentAgent?.session.header.cwd === undefined
      ? undefined
      : this.ctx.workspaceRegistry.list().find(item => item.path === parentAgent.session.header.cwd)
    const parentWorkspaceRole = parentWorkspace === undefined
      ? undefined
      : this.requireWorkspaceTable().get(String(parentWorkspace.id))?.roleId
    const parentRoleId = parentSessionId === undefined
      ? undefined
      : this.requireSessionTable().get(parentSessionId)?.roleId
        ?? this.boundRoles.get(parentSessionId)
        ?? this.provisionalRoles.get(parentSessionId)
        ?? this.requirePendingTable().get(parentSessionId)?.roleId
        ?? parentWorkspaceRole
    if (parentSessionId !== undefined && parentRoleId === undefined) {
      throw new Error(`shiori-role: parent session '${String(parentSessionId)}' has no bound role`)
    }
    const workspace = agent.session.header.cwd === undefined
      ? undefined
      : this.ctx.workspaceRegistry.list().find(item => item.path === agent.session.header.cwd)
    const initialStored = this.requireSessionTable().get(agent.session.id)
    const initialPending = initialStored === undefined ? this.requirePendingTable().get(agent.session.id)?.roleId : undefined
    const initialSelected = workspace === undefined ? undefined : this.requireWorkspaceTable().get(String(workspace.id))?.roleId
    const initialRoleId = initialStored?.roleId ?? parentRoleId ?? initialPending ?? initialSelected
    if (initialRoleId !== undefined) {
      this.requireRole(initialRoleId)
      this.provisionalRoles.set(agent.session.id, initialRoleId)
    }
    let bindingReady = Promise.resolve()
    let bindingStarted = false
    const resolveRole = (): ShioriRoleDefinition | undefined => {
      const current = this.requireSessionTable().get(agent.session.id)
      const currentPending = current === undefined ? this.requirePendingTable().get(agent.session.id)?.roleId : undefined
      const selected = current === undefined && currentPending === undefined && workspace !== undefined
        ? this.requireWorkspaceTable().get(String(workspace.id))?.roleId
        : undefined
      const roleId = current?.roleId ?? parentRoleId ?? currentPending ?? selected ?? initialRoleId
      if (roleId === undefined) return undefined
      const role = this.requireRole(roleId)
      if (current === undefined && !bindingStarted) {
        bindingStarted = true
        bindingReady = this.commitSessionRole(agent.session.id, role.id)
        void bindingReady.catch(error => {
          this.ctx.logger.error(`shiori-role: failed to persist role for session '${String(agent.session.id)}': ${String(error)}`)
        })
      }
      this.boundRoles.set(agent.session.id, role.id)
      return role
    }
    this.roleResolvers.set(agent.session.id, resolveRole)
    if (initialRoleId !== undefined) this.ensureRoleContributions(agent)
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      await bindingReady
      return next()
    })
    agent.ctx.on('agent/turn-stopping', async ({ turn, signal }) => {
      const role = resolveRole()
      if (role === undefined) return
      if (this.deletedRoles.has(role.id)) return
      await this.seedSelfOnFirstSession(agent, role, turn)
      const transcript = turnTranscript(agent, turn)
      if (!transcript) return
      const configuredExtraction = this.effectiveMemoryConfig().extraction
      const llmContext = this.resolveLlmContext(agent)
      const harnessChat = configuredExtraction === undefined && llmContext !== undefined
        ? new HarnessMemoryChatClient(llmContext, agent, turn, role.id, signal)
        : undefined
      const result = await this.requireMemoryEngine(role.id).ingest({
        content: transcript,
        sourceKind: 'conversation_turn',
        scope: { roleId: role.id, sessionKey: String(agent.session.id) },
        metadata: { source_ref: `turn:${turn}` },
      }, harnessChat)
      if (!result.accepted) {
        this.ctx.logger.warn(`shiori-role: post-turn extraction skipped: ${result.summary ?? 'unknown'}`)
      }
    })
  }

  private ensureRoleContributions(agent: Agent): void {
    if (this.roleContributionSessions.has(agent.session.id)) return
    const resolveRole = this.roleResolvers.get(agent.session.id)
    if (resolveRole === undefined) return
    agent.ctx.systemPrompt.section({
      name: PERSONA_SECTION,
      order: PERSONA_ORDER,
      text: () => {
        const role = resolveRole()
        return role === undefined ? '' : `${role.prompt}\n\n${this.readRoleSelf(role.id)}`
      },
    })
    agent.ctx.systemPrompt.context({
      name: 'shiori-role:markdown-memory',
      order: MARKDOWN_MEMORY_CONTEXT_ORDER,
      text: () => {
        const role = resolveRole()
        return role === undefined ? '' : this.readRoleMarkdownContext(role.id)
      },
    })
    this.roleContributionSessions.add(agent.session.id)
    this.ensureRoleMemoryTools(agent)
  }

  private ensureRoleMemoryTools(agent: Agent): void {
    if (this.memoryToolSessions.has(agent.session.id)) return
    const resolveRole = this.roleResolvers.get(agent.session.id)
    if (resolveRole === undefined) return
    applyMemoryTools(agent.ctx, this.memoryToolsEngine, () => {
      const role = resolveRole()
      if (role === undefined) throw new Error(`shiori-role: session '${String(agent.session.id)}' has no selected role`)
      return { roleId: role.id, sessionKey: String(agent.session.id) } satisfies RoleMemoryScope
    })
    this.memoryToolSessions.add(agent.session.id)
  }

  private async commitSessionRole(sessionId: SessionIdType, roleId: string): Promise<void> {
    await this.requireSessionTable().put(sessionId, { roleId, boundAt: new Date().toISOString(), bindingVersion: 2 })
    await this.requirePendingTable().delete(sessionId)
  }

  private async seedSelfOnFirstSession(agent: Agent, role: ShioriRoleDefinition, turn: number): Promise<void> {
    if (this.roleFiles.readSelf(role.id).trim() !== DEFAULT_SELF_MD.trim()) return
    const existing = this.selfSeedJobs.get(role.id)
    if (existing !== undefined) return existing
    const chat = this.resolveSelfSeedChat(role.id, agent, turn)
    if (chat === undefined) return
    const job = this.selfMemory.seed(role, chat).then(() => undefined).catch(error => {
      this.ctx.logger.warn(`shiori-role: SELF.md seed failed for '${role.id}': ${String(error)}`)
    }).finally(() => { this.selfSeedJobs.delete(role.id) })
    this.selfSeedJobs.set(role.id, job)
    return job
  }

  private resolveSelfSeedChat(roleId: string, agent: Agent, turn: number): MemoryChatClient | undefined {
    const configured = this.effectiveMemoryConfig().extraction
    if (configured !== undefined) return new ChatClient(configured)
    const llmContext = this.resolveLlmContext(agent)
    if (llmContext === undefined) return undefined
    try {
      return new HarnessSemanticChatClient(
        llmContext,
        agent,
        roleId,
        'self-seed',
        resolveHarnessRoute(agent, turn),
      )
    } catch {
      return undefined
    }
  }

  private resolveLlmContext(agent: Agent): Context | undefined {
    if (agent.ctx.get('llm') !== undefined) return agent.ctx
    return this.ctx.get('llm') === undefined ? undefined : this.ctx
  }

  private async maintainCompactedMemory(
    agent: Agent,
    roleId: string,
    summaryEvent: Extract<Agent['session']['events'][number], { type: 'compaction/summary' }>,
  ): Promise<void> {
    const sourceRef = `${String(agent.session.id)}@compaction:${String(summaryEvent.data.compactionId)}`
    const engine = this.requireMemoryEngine(roleId)
    if (engine.isCompactionComplete(sourceRef)) return
    const conversation = compactedTranscript(agent, summaryEvent.data.shadowedSeqs)
    if (!conversation) return
    const configured = this.effectiveMemoryConfig().extraction
    const route = { provider: summaryEvent.data.provider, model: summaryEvent.data.model }
    const consolidationChat = configured === undefined
          ? new HarnessSemanticChatClient(this.resolveLlmContext(agent) ?? this.ctx, agent, roleId, 'consolidation', route, summaryEvent.seq)
      : new ChatClient(configured)
    const result = await consolidateSemantics(conversation, this.roleFiles.readMemory(roleId), consolidationChat)
    this.markdownMemory.appendCompaction(roleId, sourceRef, result.events, result.pending)
    await engine.ingestConsolidationEvents(roleId, sourceRef, result.events)
    await engine.ingestConsolidationCandidates(roleId, sourceRef, result.candidates)

    const pending = this.markdownMemory.snapshotPending(roleId)
    if (pending) {
      try {
        const memoryChat = configured === undefined
          ? new HarnessSemanticChatClient(this.resolveLlmContext(agent) ?? this.ctx, agent, roleId, 'memory-merge', route, summaryEvent.seq)
          : new ChatClient(configured)
        if (!await this.markdownMemory.mergePending(roleId, pending, memoryChat)) {
          throw new Error('shiori-role: MEMORY.md optimizer produced no content')
        }
        const selfChat = configured === undefined
          ? new HarnessSemanticChatClient(this.resolveLlmContext(agent) ?? this.ctx, agent, roleId, 'self-update', route, summaryEvent.seq)
          : new ChatClient(configured)
        if (!await this.selfMemory.update(roleId, pending, selfChat)) {
          throw new Error('shiori-role: SELF.md optimizer produced no content')
        }
        this.markdownMemory.commitPending(roleId)
      } catch (error) {
        this.markdownMemory.rollbackPending(roleId)
        throw error
      }
    }

    const recentChat = configured === undefined
      ? new HarnessSemanticChatClient(this.resolveLlmContext(agent) ?? this.ctx, agent, roleId, 'recent-context', route, summaryEvent.seq)
      : new ChatClient(configured)
    this.markdownMemory.writeRecentContext(roleId, await consolidateRecentContext({
      previous: this.markdownMemory.readRecentContext(roleId),
      conversation,
      recentTurns: recentSurfaceTurns(agent),
      until: compactedUntil(agent, summaryEvent.data.shadowedSeqs),
    }, recentChat))
    engine.markCompactionCompleted(sourceRef)
  }

  private async enqueueRoleMaintenance(roleId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.roleMaintenanceTails.get(roleId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(task)
    this.roleMaintenanceTails.set(roleId, current)
    try {
      await current
    } finally {
      if (this.roleMaintenanceTails.get(roleId) === current) this.roleMaintenanceTails.delete(roleId)
    }
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

  private requireMemoryEngine(roleId: string): DefaultMemoryEngine {
    const id = roleId.trim()
    if (!id) throw new Error('shiori-role: role id is required for memory')
    if (this.deletedRoles.has(id) || this.requireRoleTable().get(id) === undefined) throw new UnknownRoleError(id)
    const existing = this.memoryEngines.get(id)
    if (existing !== undefined) return existing
    const effective = this.effectiveMemoryConfig()
    const store = new ShioriMemoryStore(
      resolveMemoryDbPath(resolveMemoryRoot(this.config.memoryRoot), id),
    )
    const engine = new DefaultMemoryEngine({
      store,
      ...(effective.embedding === undefined ? {} : { embedder: new Embedder(effective.embedding) }),
      ...(effective.extraction === undefined ? {} : { chat: new ChatClient(effective.extraction) }),
      config: { retrieval: resolveMemoryConfig() },
    })
    this.memoryStores.set(id, store)
    this.memoryEngines.set(id, engine)
    return engine
  }

  private disposeRoleMemory(roleId: string): void {
    this.memoryEngines.delete(roleId)
    const store = this.memoryStores.get(roleId)
    if (store !== undefined) {
      store.close()
      this.memoryStores.delete(roleId)
    }
    rmSync(resolveMemoryDbPath(resolveMemoryRoot(this.config.memoryRoot), roleId), { force: true })
  }

  /** Best-effort GC for local role assets; unknown backends remain untouched. */
  private collectOrphanAttachments(attachmentIds: readonly string[]): void {
    if (attachmentIds.length === 0) return
    const stillReferenced = new Set<string>()
    for (const [, row] of this.requireAssetTable().entries()) {
      stillReferenced.add(String(row.attachment.attachmentId))
    }
    const root = resolveMemoryRoot(undefined)
    for (const attachmentId of new Set(attachmentIds)) {
      if (stillReferenced.has(attachmentId)) continue
      const match = /^sha256:([a-f0-9]{64})$/.exec(attachmentId)
      if (match?.[1] === undefined) continue
      rmSync(join(root, 'attachments', 'v1', 'objects', match[1].slice(0, 2), match[1]), { force: true })
    }
  }

  private readRoleSelf(roleId: string): string {
    if (this.deletedRoles.has(roleId)) throw new UnknownRoleError(roleId)
    return this.selfMemory.read(roleId)
  }

  private readRoleMarkdownContext(roleId: string): string {
    if (this.deletedRoles.has(roleId)) throw new UnknownRoleError(roleId)
    return this.markdownMemory.context(roleId)
  }

  private requireMemoryTable(): KvTable<string, StoredRoleMemoryRecord> {
    if (this.memoryTable === undefined) throw new Error('shiori-role: service is not started')
    return this.memoryTable
  }

  private requireMemoryConfigTable(): KvTable<string, MemoryConfigRecord> {
    if (this.memoryConfigTable === undefined) throw new Error('shiori-role: service is not started')
    return this.memoryConfigTable
  }
}

function resolveMemoryRoot(configured?: string): string {
  return configured?.trim() || process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

function scopeRoleId(scope: string | { readonly roleId?: string } | undefined): string {
  return typeof scope === 'string' ? scope : scope?.roleId ?? ''
}

/** 校验并规整端点配置（endpoint / model 必填）。 */
function sanitizeEndpoint(endpoint: MemoryEndpointConfig): MemoryEndpointConfig {
  const url = endpoint.endpoint.trim()
  const model = endpoint.model.trim()
  if (!url) throw new Error('shiori-role: memory endpoint must not be empty')
  if (!model) throw new Error('shiori-role: memory model must not be empty')
  return {
    endpoint: url,
    model,
    ...(endpoint.apiKey?.trim() ? { apiKey: endpoint.apiKey.trim() } : {}),
  }
}

/** One model-facing conversation line per message within a turn, user and assistant only. */
function turnTranscript(agent: Agent, turn: number): string {
  const events = agent.session.events
  const start = events.findIndex(event => event.type === 'turn/start' && event.data.turn === turn)
  if (start === -1) return ''
  const lines: string[] = []
  for (let index = start + 1; index < events.length; index += 1) {
    const event = events[index]!
    if (event.type === 'turn/start') break
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      lines.push(`USER: ${messageText(event.data.content)}`)
    } else if (event.type === 'assistant/message') {
      lines.push(`ASSISTANT: ${messageText(event.data.message.content)}`)
    }
  }
  return lines.join('\n')
}

/** Format the exact surface events shadowed by one successful compaction. */
function compactedTranscript(agent: Agent, shadowedSeqs: readonly number[]): string {
  const selected = new Set(shadowedSeqs)
  const lines: string[] = []
  for (const event of agent.session.events) {
    if (!selected.has(event.seq)) continue
    const timestamp = formatMessageTime(event.time)
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const text = messageText(event.data.content)
      if (text) lines.push(`[${timestamp}] USER: ${text}`)
    } else if (event.type === 'assistant/message') {
      const text = messageText(event.data.message.content)
      if (text) lines.push(`[${timestamp}] ASSISTANT: ${text}`)
    }
  }
  return lines.join('\n')
}

function recentSurfaceTurns(agent: Agent): string {
  const lines: string[] = []
  for (const seq of agent.session.surface.nodes) {
    const event = agent.session.events[seq]
    if (event?.type === 'user/message' && event.data.source.kind === 'user') {
      const text = messageText(event.data.content)
      if (text) lines.push(`[user] ${text}`)
    } else if (event?.type === 'assistant/message') {
      const text = messageText(event.data.message.content)
      if (text) lines.push(`[a-preview] ${text.slice(0, 300)}`)
    }
  }
  return lines.slice(-6).join('\n')
}

function compactedUntil(agent: Agent, shadowedSeqs: readonly number[]): string {
  const times = shadowedSeqs.flatMap(seq => {
    const event = agent.session.events[seq]
    return event === undefined ? [] : [event.time]
  })
  return times.length === 0 ? '' : formatShanghaiTimestamp(Math.max(...times))
}

function formatShanghaiTimestamp(value: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '00'
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}+08:00`
}

function formatMessageTime(value: number): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value)).replace(' ', ' ')
}

/** Concatenate the visible text blocks of one message. */
function messageText(blocks: readonly { readonly type: string; readonly text?: unknown }[]): string {
  return blocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join(' ')
    .trim()
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
