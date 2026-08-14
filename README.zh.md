# dsh-plugin-shiori-role

面向 DeepSeek Harness 的原生 Shiori 角色插件，为工作区提供角色绑定能力。

## 范围

本仓库提供 Cordis 插件，让一个工作区为之后创建的 session 选择一个默认角色。Agent 创建时固定角色；修改工作区当前角色不会热切换正在运行的 Agent。

角色插件负责：

- 角色身份和行为 prompt；
- 角色作用域内的记忆服务和工具；
- 角色生命周期和释放；
- 与 session 关联的持久角色绑定。

Agent preset 继续负责 Agent 的能力组合。工作区角色和 Agent preset 是两个独立选择。

## 第一阶段

1. 发现并校验角色定义。
2. 保存每个工作区的当前角色。
3. 创建或恢复 Agent 时绑定角色。
4. 持久化 session 的角色绑定。
5. 证明切换工作区角色只影响之后创建的 session。

Shiori 现有 Python runtime 是产品行为的迁移来源，但本仓库使用 deepseek-harness 的原生 TypeScript/ESM Cordis package 实现。

## 包入口

包导出名为 `shiori-role` 的 Cordis 函数插件，可以在 Agent scope 中挂载一个角色定义：

```yaml
- id: role-shiori-maintainer
  name: '@deepseek-ai/dsh-plugin-shiori-role'
  config:
    id: shiori-maintainer
    name: Shiori Maintainer
    prompt: 你是这个工作区的 Shiori 维护者。
```

当前入口负责角色身份 prompt。工作区选择、session 绑定和角色记忆会在不改变角色 prompt 契约的前提下继续接入。

## 领域层

`WorkspaceRoleRegistry` 管理经过校验的角色目录和工作区当前角色。当前角色只是之后创建 Agent 的默认值；Agent 创建边界应将解析出的 `roleId` 固化到 session，已有 Agent 不会重新读取工作区默认值。

