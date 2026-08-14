# dsh-plugin-shiori-role

A native DeepSeek Harness plugin for editable Shiori roles, session-scoped identity, role-owned visuals, and isolated durable memory.

[中文说明](README.zh.md)

## Features

- Manage roles in `Settings -> Plugins -> Roles`. The page contains role cards and a create card; each role opens in a modal for editing its name, introduction, System Prompt, avatar, standing illustration, and image library.
- Select a role from the conversation composer. A blank session can switch roles repeatedly; the first System Prompt assembly commits the selection, and a running or resumed session remains immutable.
- Preview the selected role immediately. The plugin applies role-owned theme tokens and uses the standing illustration as a sidebar/workspace visual layer without changing the user's light, dark, or system preference.
- Store images through the Harness attachment service. Plugin KV tables retain only `ImageAttachmentRef` metadata, never base64 image blobs.
- Keep durable memories isolated by role and expose `memorize`, `recall_memory`, and `forget_memory` in the bound Agent scope.

All backend services, Remote descriptors, client slots, styles, and theme cleanup live in this plugin. No DeepSeek Harness source patch is required.

## Configuration

Configured roles are imported once as editable seeds. Later edits and deletions remain durable and deleted seeds are not recreated after restart.

```yaml
- id: shiori-role
  name: '@deepseek-ai/dsh-plugin-shiori-role'
  config:
    roles:
      - id: maintainer
        name: Shiori Maintainer
        introduction: Maintains the Shiori workspace.
        prompt: You are the Shiori maintainer for this workspace.
```

For local development, install the repository as a linked profile dependency:

```yaml
dependencies:
  '@deepseek-ai/dsh-plugin-shiori-role': link:D://Coding//dsh-plugin-shiori-role
```

## Role Binding

`ShioriRoleService` stores editable roles, assets, workspace defaults, pending blank-session selections, and immutable session bindings in the `shiori_role` storage domain.

Creating a blank Agent does not lock its role. The composer stages a pending selection, while the persona provider and memory tools resolve that selection dynamically. The first System Prompt assembly commits the role with binding version 2 before model execution continues. Existing version-1 bindings are migrated back to pending only when the live Agent log proves the session is still blank. Sessions with user messages or started turns never migrate or hot-switch.

Deleting a role removes it from the editable catalog and future-session selectors. If an immutable session already uses it, the plugin keeps a tombstone with its Prompt, assets, and memory so that resumed session remains reconstructable. Mutable pending and workspace references are reassigned to the earliest remaining role, and every client surface refreshes from the same catalog mutation signal.

## Assets And Theme

Supported asset purposes are `avatar`, `portrait`, `gallery`, and `theme_background`. Avatar and portrait uploads are separate. Binary image data is saved and read through `ctx.attachments.saveImage/readImage`; role asset rows contain attachment references only.

The selected role controls the composer avatar and role name. Its portrait can influence the workspace and sidebar through plugin-owned CSS and `ctx.theme.overrideTokens`. Plugin disposal removes the injected stylesheet, theme override, classes, CSS variables, and image URLs.

## Role Memory

Each role owns an isolated durable memory scope. Records are stored in the global DSH data root at `$DSH_HOME/shiori-plugin/role/<role-id>/memory/memory.json` (shared by every DSH workspace) and follow the Shiori `memory_items` shape: `summary`, `memoryType`, `contentHash`, structured `extra` metadata, `sourceRef`, `happenedAt`, `status`, reinforcement count, durable ids, and timestamps. Role/session/channel/chat scope is persisted with the record. Cross-role reads and deletes are rejected; source references can be removed as a group, and active memories are rendered into the Agent's System Prompt context.

This version intentionally does not claim full Shiori `default_memory` parity. It provides deterministic case-insensitive text retrieval, exact-match reinforcement, explicit memory tools, and prompt injection. Embeddings, hybrid retrieval/reranking, automatic post-turn extraction, consolidation, and background ingestion are not implemented yet.

## Development

```powershell
D:\Coding\deepseek-harness\node_modules\.bin\tsc.cmd --noEmit --project tsconfig.json
node --import file:///D:/Coding/deepseek-harness/node_modules/tsx/dist/esm/index.mjs --test test/*.test.ts
D:\Coding\deepseek-harness\node_modules\.bin\tsc.cmd --project tsconfig.json
D:\Coding\deepseek-harness\node_modules\.bin\tsdown.cmd --config tsdown.config.ts
```
