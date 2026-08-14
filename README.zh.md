# dsh-plugin-shiori-role

面向 DeepSeek Harness 的原生 Shiori 角色插件，为工作区提供角色绑定能力。

## 范围

这是一个 Cordis service 插件，让工作区为之后创建的 session 选择默认角色。Agent 发布时固定角色；修改工作区角色不会热切换正在运行的 Agent。Agent preset 继续负责能力组合。

## 配置与 UI

在宿主边界配置角色目录：

```yaml
- id: shiori-role
  name: '@deepseek-ai/dsh-plugin-shiori-role'
  config:
    roles:
      - id: maintainer
        name: Shiori Maintainer
        prompt: 你是这个工作区的 Shiori 维护者。
```

Harness 的 Settings -> Plugins -> 角色页会显示工作区选择器和角色按钮。宿主 Remote 命名空间是 `remote.shioriRole`，提供 `snapshot(workspaceId)` 和 `select(workspaceId, roleId)`；客户端贡献由插件自己挂载，并随插件释放。

## 角色绑定

`WorkspaceRoleRegistry` 管理经过校验的角色目录和工作区默认值。`ShioriRoleService` 在 `shiori_role` domain 中保存工作区默认角色和不可变的 session 角色绑定。Agent 发布时，插件根据 session 的 `cwd` 解析工作区，把 persona 和记忆工具挂入 Agent scope，并在第一次 prompt assemble 继续前持久化绑定。恢复 session 时始终使用 durable binding，即使工作区默认角色已经改变。

本插件不会向 Harness core 添加未经登记的自定义 session event；模型可见的角色 prompt 仍可通过记录的 request header 重建。

## 角色记忆

每个已绑定角色在同一个 domain 中拥有隔离的持久记忆表。公开契约保留 Shiori 结构化记忆的形状：scope、kind、domain、来源引用、evidence、status、持久化 id 和强化次数。Agent 作用域注册 `memorize`（保存或强化事实）、`recall_memory`（按文本、kind、domain、limit 查询 active 记忆）和 `forget_memory`（按 id 删除）三个原生工具，跨角色读取和删除会被拒绝；当前记忆块会带着记忆 id 注入 Agent prompt。

这一版原生插件不宣称与 Shiori `default_memory` 完全等价：检索使用确定性的大小写不敏感子串匹配和精确重复强化，暂未实现 embedding、语义 reranking、自动回合后抽取和 ingest。工具在角色绑定后注册，并随 Agent scope 释放。

## 开发验证

```powershell
D:\Coding\deepseek-harness\node_modules\.bin\tsc.cmd --noEmit --project tsconfig.json
node --import file:///D:/Coding/deepseek-harness/node_modules/tsx/dist/esm/index.mjs --test test/*.test.ts
D:\Coding\deepseek-harness\node_modules\.bin\tsdown.cmd --config tsdown.config.ts
```
