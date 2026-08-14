# dsh-plugin-shiori-role

Native DeepSeek Harness role plugin for workspace-scoped Shiori characters.

## Scope

This Cordis service lets a workspace select a default role for future sessions. The role is fixed when an Agent is published; changing the workspace role never hot-switches a running Agent. Agent presets remain responsible for capability composition.

## Configuration And UI

Configure the role catalog at the host boundary:

```yaml
- id: shiori-role
  name: '@deepseek-ai/dsh-plugin-shiori-role'
  config:
    roles:
      - id: maintainer
        name: Shiori Maintainer
        prompt: You are the Shiori maintainer for this workspace.
```

Harness Settings -> Plugins -> Roles exposes the workspace selector and configured role buttons. The host Remote namespace is `remote.shioriRole` with `snapshot(workspaceId)` and `select(workspaceId, roleId)`. The client contribution is mounted and disposed by the plugin.

## Role Binding

`WorkspaceRoleRegistry` validates the role catalog and workspace defaults. `ShioriRoleService` stores workspace defaults and immutable session bindings in the `shiori_role` domain. When an Agent is published, the plugin resolves its workspace from the session `cwd`, mounts the persona and memory tools into that Agent scope, and persists the binding before the first prompt assembly continues. A resumed session always uses its durable binding, even if the workspace default has changed.

The plugin does not add an unregistered custom session event to Harness core; the model-visible role prompt remains reconstructable from the recorded request header.

## Role Memory

Each bound role has an isolated durable memory table in the same domain. The public contract mirrors Shiori's structured memory shape: scope, kind, domain, source references, evidence, status, durable ids, and reinforcement counts. The Agent-scope tools are `memorize` (save or reinforce), `recall_memory` (query active memories with optional text, kind, domain, and limit filters), and `forget_memory` (delete by id). Cross-role reads and deletes are rejected, and the current memory block is added to the Agent prompt with memory ids.

This first native slice does not claim full Shiori `default_memory` parity. Retrieval is deterministic case-insensitive substring matching with exact-match reinforcement; embeddings, semantic reranking, and automatic post-turn extraction/ingestion are not implemented. Tools are registered after role binding and disposed with the Agent scope.

## Development

```powershell
D:\Coding\deepseek-harness\node_modules\.bin\tsc.cmd --noEmit --project tsconfig.json
node --import file:///D:/Coding/deepseek-harness/node_modules/tsx/dist/esm/index.mjs --test test/*.test.ts
D:\Coding\deepseek-harness\node_modules\.bin\tsdown.cmd --config tsdown.config.ts
```
