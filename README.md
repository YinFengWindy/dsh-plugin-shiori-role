# dsh-shiori-role

Native DeepSeek Harness role plugin for workspace-scoped Shiori characters.

## Scope

This repository will provide a Cordis plugin that binds one role to a workspace for newly created sessions. The role is fixed when an Agent is created; changing the workspace's active role does not hot-switch running Agents.

The role plugin owns:

- role identity and behavior prompt sections;
- role-scoped memory services and tools;
- role lifecycle and disposal;
- the durable role binding associated with each session.

Agent presets remain responsible for the Agent's capability composition. A workspace role and an Agent preset are independent selections.

## First Vertical Slice

1. Discover and validate role definitions.
2. Store the active role for each workspace.
3. Bind the active role during Agent creation and resume.
4. Persist the session's role binding.
5. Prove that changing the workspace role affects only later sessions.

Shiori's existing Python runtime is the source of product behavior to migrate, but this repository is implemented as a native TypeScript/ESM Cordis package for deepseek-harness.

