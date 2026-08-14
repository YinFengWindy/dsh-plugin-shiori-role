import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { shioriRoleDomainSpec, type SessionRoleRecord, type StoredRoleMemoryRecord, type WorkspaceRoleRecord } from './spec.ts'
import { apply as applyRolePlugin, type Config as RolePluginConfig } from './role-plugin.ts'
import type { ShioriRoleDefinition, WorkspaceRoleSnapshot } from './types.ts'
import type { RoleMemoryScope } from './memory-contract.ts'
import { DuplicateRoleError, UnknownRoleError, WorkspaceRoleRegistry } from './registry.ts'
import { applyMemoryTools, ShioriMemoryService } from './memory.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    shioriRole: ShioriRoleService
  }
}

/** Service configuration for the role catalog. */
export interface Config {
  readonly roles: readonly ShioriRoleDefinition[]
}

/**
 * Workspace role service. It owns durable active-role selections and composes
 * the selected role into an unpublished Agent scope.
 */
export class ShioriRoleService extends TypertRemoteService {
  static inject = ['storageDomain', 'workspaceRegistry']

  private domain?: Domain<typeof shioriRoleDomainSpec>
  private table?: KvTable<string, WorkspaceRoleRecord>
  private sessionTable?: KvTable<SessionId, SessionRoleRecord>
  private memoryTable?: KvTable<string, StoredRoleMemoryRecord>
  private memoryService?: ShioriMemoryService
  private readonly boundRoles = new Map<SessionId, string>()
  private readonly catalog: WorkspaceRoleRegistry

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'shioriRole')
    this.catalog = new WorkspaceRoleRegistry(config.roles, {
      get: async workspace => this.requireTable().get(workspace)?.roleId,
      set: async (workspace, roleId) => {
        await this.requireTable().put(workspace, { roleId, updatedAt: new Date().toISOString() })
      },
    })
  }

  protected async [Service.init](): Promise<void> {
    this.domain = await this.ctx.storageDomain.open(shioriRoleDomainSpec)
    this.ctx.effect(() => () => { void this.domain?.close() }, 'shioriRole.domainClose')
    this.table = this.domain.table('workspace_roles')
    this.sessionTable = this.domain.table('session_roles')
    this.memoryTable = this.domain.table('memories')
    this.memoryService = new ShioriMemoryService(this.memoryTable)
    this.ctx.inject(['agents', 'systemPrompt', 'tools'], (runtimeCtx) => {
      for (const agent of runtimeCtx.agents.list()) this.mountAgent(agent)
      runtimeCtx.on('agent/created', ({ agent }) => { this.mountAgent(agent) })
      runtimeCtx.on('agent/disposed', ({ agent }) => { this.boundRoles.delete(agent.session.id) })
    })
  }

  /** List the configured role definitions. */
  list(): readonly ShioriRoleDefinition[] {
    return this.catalog.list()
  }

  /** Read the client-safe role catalog and active selection for a workspace. */
  @Remote('snapshot')
  async snapshot(workspaceId: string): Promise<WorkspaceRoleSnapshot> {
    const active = await this.active(workspaceId as WorkspaceId)
    return {
      workspaceId,
      roles: this.catalog.list().map(role => ({ id: role.id, name: role.name })),
      ...(active === undefined ? {} : { activeRoleId: active.id }),
    }
  }

  /** Change the default role used by future sessions in one workspace. */
  @Remote('select')
  async selectRemote(workspaceId: string, roleId: string): Promise<WorkspaceRoleSnapshot> {
    await this.select(workspaceId as WorkspaceId, roleId)
    return this.snapshot(workspaceId)
  }

  /** Resolve a configured role by id. */
  get(roleId: string): ShioriRoleDefinition | undefined {
    return this.catalog.get(roleId)
  }

  /** Set the active role for a workspace. */
  select(workspaceId: WorkspaceId, roleId: string): Promise<void> {
    return this.catalog.select(String(workspaceId), roleId)
  }

  /** Read the active role for a workspace. */
  active(workspaceId: WorkspaceId): Promise<ShioriRoleDefinition | undefined> {
    return this.catalog.active(String(workspaceId))
  }

  /**
   * Compose the session's fixed role into an unpublished Agent scope.
   * Resumed sessions use their logged role; fresh sessions use the workspace
   * selection resolved from the Agent's canonical cwd.
   */
  async compose(agentCtx: Context, roleId?: string): Promise<ShioriRoleDefinition> {
    const agent = scopeOf(agentCtx) as Agent | undefined
    if (agent === undefined || agent.session === undefined) throw new Error('shiori-role: compose requires an Agent scope')

    const sessionRoleId = this.requireSessionTable().get(agent.session.id)?.roleId
    if (sessionRoleId !== undefined && roleId !== undefined && roleId !== sessionRoleId) {
      throw new Error(`shiori-role: session '${agent.id}' is already bound to '${sessionRoleId}'`)
    }
    const workspaceRole = sessionRoleId === undefined ? await this.resolveWorkspaceRole(agent) : undefined
    const resolved = this.catalog.require(roleId ?? sessionRoleId ?? workspaceRole?.id ?? '')
    if (sessionRoleId === undefined) {
      await this.requireSessionTable().put(agent.session.id, {
        roleId: resolved.id,
        boundAt: new Date().toISOString(),
      })
    }
    await agentCtx.plugin(applyRolePlugin, {
      id: resolved.id,
      name: resolved.name,
      prompt: resolved.prompt,
    } satisfies RolePluginConfig)
    const memoryPlugin = Object.assign(
      (inner: Context) => applyMemoryTools(inner, this.requireMemoryService(), resolved.id),
      { inject: ['systemPrompt', 'tools'] },
    )
    await agentCtx.plugin(memoryPlugin)
    this.boundRoles.set(agent.session.id, resolved.id)
    return resolved
  }

  /** Access the role-scoped memory facade after service initialization. */
  memory(): ShioriMemoryService {
    return this.requireMemoryService()
  }

  /** Resolve a workspace role from the session's canonical working directory. */
  private async resolveWorkspaceRole(agent: Agent): Promise<ShioriRoleDefinition | undefined> {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return undefined
    const workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd)
    return workspace === undefined ? undefined : await this.active(workspace.id)
  }

  /** Bind and mount a role synchronously at the Agent publication boundary. */
  private mountAgent(agent: Agent): void {
    if (this.boundRoles.has(agent.session.id)) return
    const stored = this.requireSessionTable().get(agent.session.id)
    const workspace = stored === undefined && agent.session.header.cwd !== undefined
      ? this.ctx.workspaceRegistry.list().find(item => item.path === agent.session.header.cwd)
      : undefined
    const selected = workspace === undefined ? undefined : this.requireTable().get(String(workspace.id))
    const roleId = stored?.roleId ?? selected?.roleId
    if (roleId === undefined) return
    const role = this.catalog.require(roleId)
    const scope: RoleMemoryScope = { roleId: role.id, sessionKey: String(agent.session.id) }
    let bindingReady = Promise.resolve()
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      await bindingReady
      return next()
    })
    applyRolePlugin(agent.ctx, { id: role.id, name: role.name, prompt: role.prompt })
    applyMemoryTools(agent.ctx, this.requireMemoryService(), scope)
    if (stored === undefined) {
      bindingReady = this.requireSessionTable().put(agent.session.id, {
        roleId: role.id,
        boundAt: new Date().toISOString(),
      })
      void bindingReady.catch(error => {
        this.ctx.logger.error(`shiori-role: failed to persist role for session '${String(agent.session.id)}': ${String(error)}`)
      })
    }
    this.boundRoles.set(agent.session.id, role.id)
  }

  private requireTable(): KvTable<string, WorkspaceRoleRecord> {
    if (this.table === undefined) throw new Error('shiori-role: service is not started')
    return this.table
  }

  private requireSessionTable(): KvTable<SessionId, SessionRoleRecord> {
    if (this.sessionTable === undefined) throw new Error('shiori-role: service is not started')
    return this.sessionTable
  }

  private requireMemoryService(): ShioriMemoryService {
    if (this.memoryService === undefined) throw new Error('shiori-role: service is not started')
    return this.memoryService
  }
}

export { DuplicateRoleError, UnknownRoleError }
