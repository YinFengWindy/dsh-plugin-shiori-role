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

Each role owns an isolated durable memory scope shared by every DSH workspace. Its editable definition is stored at `$DSH_HOME/shiori-plugin/role/<role-id>/role.json`; the complete readable memory projection lives under `$DSH_HOME/shiori-plugin/role/<role-id>/memory/`: `MEMORY.md` holds stable facts, preferences, and explicit remember requests; `HISTORY.md` is the append-only shared timeline; `PENDING.md` buffers long-term candidates; `RECENT_CONTEXT.md` preserves recent topics and ongoing work; and `SELF.md` maintains the role's self-model. Searchable structured memory remains in the adjacent `memory2.db`.

The Shiori semantic layer is active without a `memory` config block. After every completed turn, a bounded auxiliary request through the Agent's current Harness provider/model extracts long-term memories before the turn closes. An optional `extraction` endpoint overrides that default call. An optional `embedding` endpoint adds independent vector recall; without it, retrieval degrades to deterministic text search.

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

Retrieval mirrors Shiori's `memory2`: the keyword lane keeps literal hits while the vector lane recalls semantically similar rows independently (cosine threshold 0.35), then Reciprocal Rank Fusion merges both ranked lanes (`1/(60+vec_rank) + 0.5/(60+keyword_rank)`) with hotness boosting. Post-turn extraction follows Shiori too: `agent/turn-stopping` feeds the turn's `USER`/`ASSISTANT` conversation to a separate bounded model request, which applies Shiori's long-term memory contract (verbatim user anchors, cross-session durability, source direction, no events) and returns `profile` / `preference` / `procedure` memories with `emotional_weight` and friends. The listener waits for the write before the turn closes; extraction failure is logged and does not fail the completed response. Changed memory context is materialized by Harness as an append-only runtime-context snapshot, preserving the reusable request prefix.

Memory is stored per role in SQLite (`<memoryRoot>/shiori-plugin/role/<role-id>/memory/memory2.db`, built-in `node:sqlite`, zero dependencies). Explicit `memorize` writes reinforce by content hash; on write, semantically similar old rows are retired automatically (preference/profile similarity ≥ 0.90, high-emotion profile 0.92) and procedures sharing a `tool_requirement` merge. Successful Harness compaction feeds the exact `shadowedSeqs` window through Shiori's semantic consolidation rules. Role-scoped maintenance runs serially: it appends `history_entries` and `pending_items`, snapshots `PENDING.md`, immediately merges the snapshot into `MEMORY.md`, updates `SELF.md` from the same snapshot, generates `RECENT_CONTEXT.md`, and commits the snapshot. A failed optimizer restores the snapshot. SQLite stores the corresponding events and long-term candidates under stable per-entry source refs, then records the completed compaction source ref so replay is a no-op. `SELF.md`, `MEMORY.md`, and the compact portion of `RECENT_CONTEXT.md` are injected into the role context; `PENDING.md` is never injected and `HISTORY.md` remains a maintained timeline.

This version intentionally does not claim full Shiori `default_memory` parity. It provides deterministic text retrieval, embedding semantic retrieval with hybrid RRF ranking, exact-match reinforcement, semantic supersede/merge, explicit memory tools, automatic post-turn extraction, compaction-driven Markdown consolidation, immediate role-scoped optimization, and prompt injection. HyDE, query rewriting, scheduled optimization, journal projection, and background ingestion are not implemented.

## Development

```powershell
D:\Coding\deepseek-harness\node_modules\.bin\tsc.cmd --noEmit --project tsconfig.json
node --import file:///D:/Coding/deepseek-harness/node_modules/tsx/dist/esm/index.mjs --test test/*.test.ts
D:\Coding\deepseek-harness\node_modules\.bin\tsc.cmd --project tsconfig.json
D:\Coding\deepseek-harness\node_modules\.bin\tsdown.cmd --config tsdown.config.ts
```
