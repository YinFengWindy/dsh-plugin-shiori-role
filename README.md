# dsh-plugin-shiori-role

Native DeepSeek Harness role plugin for workspace-scoped Shiori characters.

## Scope

This repository provides a Cordis plugin that lets a workspace select one default role for future sessions. The role is fixed when an Agent is created; changing the workspace's active role never hot-switches a running Agent.

The role plugin owns:

- role identity and behavior prompt sections;
- role-scoped memory services and tools;
- role lifecycle and disposal;
- the durable role binding associated with each session.

Agent presets remain responsible for the Agent's capability composition. A workspace role and an Agent preset are independent selections.

## First Vertical Slice

1. Discover and validate role definitions.
2. Store the active role for each workspace.
3. Bind the selected role during Agent creation and resume.
4. Persist the session role binding in a durable role sidecar.
5. Prove that changing the workspace role affects only later sessions.

Shiori's existing Python runtime is the source of product behavior to migrate, but this repository is implemented as a native TypeScript/ESM Cordis package for deepseek-harness.

## Package Entry Point

The package exports a Cordis function plugin named `shiori-role`. Mount it in an Agent scope with a role definition:

```yaml
- id: role-shiori-maintainer
  name: '@deepseek-ai/dsh-plugin-shiori-role'
  config:
    id: shiori-maintainer
    name: Shiori Maintainer
    prompt: You are the Shiori maintainer for this workspace.
```

The role service persists workspace defaults and session bindings in its own durable domain. It does not add an unregistered custom session event to the harness core; the model-visible role prompt remains reconstructable from the recorded request header.

## Domain Layer

`WorkspaceRoleRegistry` owns the validated role catalog and each workspace's active role selection. `ShioriRoleService` stores both workspace defaults and immutable session bindings in the `shiori-role` storage domain. The active role is only a default for future Agent creation; the Agent-creation boundary persists the resolved `roleId`, and existing Agents must not reread the workspace default.

## Role Memory

Each bound role gets an isolated durable memory table in the same `shiori_role` domain. The native Agent-scope tools are `memorize` (save a fact), `recall_memory` (list recent facts with optional text filtering), and `forget_memory` (delete by id). Cross-role reads and deletes are rejected by construction. The first slice uses deterministic text matching rather than embeddings. Tools are registered after role binding and disposed with the Agent scope; hosts must load `@deepseek-ai/dsh-tools` with the normal system-prompt and storage services.
