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
4. Persist the session role binding.
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

The current entry point owns only the role identity contribution. Workspace selection, session binding, and role memory will be added without changing the role prompt contract.

## Domain Layer

`WorkspaceRoleRegistry` owns the validated role catalog and each workspace's active role selection. The active role is only a default for future Agent creation; the Agent-creation boundary must persist the resolved `roleId` with the session, and existing Agents must not reread the workspace default.
