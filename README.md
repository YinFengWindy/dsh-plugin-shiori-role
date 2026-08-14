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

Each role owns an isolated durable memory scope shared by every DSH workspace. The global `$DSH_HOME/shiori-plugin/role/<role-id>/memory/` directory has two synchronized layers: `semantic.json` stores Shiori-shaped structured records for query, deduplication, scope, status, and reinforcement; `MEMORY.md` is the model-facing and human-readable long-term document. `SELF.md`, `HISTORY.md`, `RECENT_CONTEXT.md`, and `PENDING.md` are initialized beside it using Shiori's role-memory document layout. Semantic writes update a marked block in `MEMORY.md` without replacing manually authored Markdown outside that block.

A `memory` config block enables the Shiori semantic layer: `embedding` points at an OpenAI-compatible vector endpoint (embeddings are generated on write and used for independent vector recall on query), and `extraction` points at an OpenAI-compatible chat endpoint (long-term memories are extracted asynchronously after each turn). When neither endpoint is configured, retrieval degrades to deterministic text search and everything still works.

```yaml
- id: shiori-role
  name: '@deepseek-ai/dsh-plugin-shiori-role'
  config:
    roles:
      - id: maintainer
        name: Shiori Maintainer
        introduction: Maintains the Shiori workspace.
        prompt: You are the Shiori maintainer for this workspace.
    memory:
      embedding:
        endpoint: https://api.openai.com/v1
        apiKey: sk-...
        model: text-embedding-3-small
      extraction:
        endpoint: https://api.openai.com/v1
        apiKey: sk-...
        model: gpt-4o-mini
```

Retrieval mirrors Shiori's `memory2`: the keyword lane keeps literal hits while the vector lane recalls semantically similar rows independently (cosine threshold 0.35), then Reciprocal Rank Fusion merges both ranked lanes (`1/(60+vec_rank) + 0.5/(60+keyword_rank)`). Post-turn extraction follows Shiori too: `agent/turn-stopping` feeds the turn's `USER`/`ASSISTANT` conversation to the extraction endpoint, which applies Shiori's long-term memory contract (verbatim user anchors, cross-session durability, source direction, no events) and returns `profile` / `preference` / `procedure` memories with `emotional_weight` and friends, persisted asynchronously. Explicit `memorize` writes still reinforce by content hash.

This version intentionally does not claim full Shiori `default_memory` parity. It provides deterministic case-insensitive text retrieval, embedding semantic retrieval with hybrid RRF ranking, exact-match reinforcement, explicit memory tools, automatic post-turn extraction, and prompt injection. Consolidation (supersede/merge) and background ingestion are not implemented yet.

## Development

```powershell
D:\Coding\deepseek-harness\node_modules\.bin\tsc.cmd --noEmit --project tsconfig.json
node --import file:///D:/Coding/deepseek-harness/node_modules/tsx/dist/esm/index.mjs --test test/*.test.ts
D:\Coding\deepseek-harness\node_modules\.bin\tsc.cmd --project tsconfig.json
D:\Coding\deepseek-harness\node_modules\.bin\tsdown.cmd --config tsdown.config.ts
```
