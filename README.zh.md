# dsh-plugin-shiori-role

面向 DeepSeek Harness 的原生 Shiori 角色插件，提供可编辑角色、会话级身份绑定、角色素材和隔离的持久记忆。

[English](README.md)

## 功能

- 在 `设置 -> 插件 -> 角色` 中管理角色。页面只显示角色卡片和创建卡片；点击角色卡片后，通过弹层编辑名称、简介、System Prompt、头像、立绘和图片素材库。
- 在聊天输入框选择角色。空白会话可以反复切换；第一次组装 System Prompt 时提交选择，已有内容或恢复的会话保持角色不可变。
- 立即预览当前选择的角色。插件通过角色主题 token 和立绘影响侧栏、工作区，不修改用户的浅色、深色或跟随系统偏好。
- 图片统一交给 Harness attachment service 保存。插件 KV 表只保存 `ImageAttachmentRef` 元数据，不保存 base64 图片。
- 按角色隔离持久记忆，并在已绑定的 Agent scope 中提供 `memorize`、`recall_memory`、`forget_memory`。

后端服务、Remote 描述、客户端 slot、样式和主题清理全部位于插件内部，不需要修改 DeepSeek Harness 源码。

## 配置

配置中的角色只会作为可编辑种子导入一次。之后的修改和删除会持久化，重启不会重新创建已删除的种子角色。

```yaml
- id: shiori-role
  name: '@deepseek-ai/dsh-plugin-shiori-role'
  config:
    roles:
      - id: maintainer
        name: Shiori Maintainer
        introduction: 维护 Shiori 工作区。
        prompt: 你是这个工作区的 Shiori 维护者。
```

本地开发时，可以把仓库作为 profile 的链接依赖安装：

```yaml
dependencies:
  '@deepseek-ai/dsh-plugin-shiori-role': link:D://Coding//dsh-plugin-shiori-role
```

## 角色绑定

`ShioriRoleService` 在 `shiori_role` storage domain 中保存可编辑角色、素材、工作区默认角色、空白会话的待选角色和不可变的会话绑定。

创建空白 Agent 时不会锁定角色。输入框只暂存 pending 选择，persona provider 和记忆工具会动态解析该选择。第一次组装 System Prompt 时，插件在模型执行前以 binding version 2 提交角色。旧版 version 1 绑定只有在实时 Agent 日志能证明会话仍为空白时，才会迁回 pending；已经出现用户消息或 turn/start 的会话不会迁移，也不会热切换角色。

删除角色会将其从可编辑目录和新会话选择器中移除。如果已有不可变会话正在使用它，插件会保留包含 Prompt、素材和记忆的 tombstone，保证恢复会话仍可重建。删除空白会话待选角色或工作区默认角色时，可变引用会改到目录中最早的剩余角色，并通过同一个 catalog 变更信号同步刷新所有插件 UI。

## 素材与主题

素材用途包括 `avatar`、`portrait`、`gallery` 和 `theme_background`。头像和立绘分别上传；图片二进制通过 `ctx.attachments.saveImage/readImage` 保存和读取，角色素材表只保存 attachment 引用。

当前会话角色控制输入框中的头像和名称。立绘可以通过插件自有 CSS 和 `ctx.theme.overrideTokens` 影响工作区与侧栏。插件释放时会清理注入的 stylesheet、主题覆盖、class、CSS 变量和图片 URL。

## 角色记忆

每个角色拥有隔离的持久记忆作用域，并由所有 DSH workspace 共享。全局目录 `$DSH_HOME/shiori-plugin/role/<role-id>/memory/` 包含同步的两层存储：`semantic.json` 保存 Shiori 风格的结构化记录，负责检索、去重、作用域、状态和强化；`MEMORY.md` 是模型实际读取且方便人工编辑的长期记忆文档。目录中还会按 Shiori 角色记忆布局初始化 `SELF.md`、`HISTORY.md`、`RECENT_CONTEXT.md` 和 `PENDING.md`。语义写入只同步 `MEMORY.md` 中带标记的自动区块，不覆盖区块外人工编写的 Markdown。

配置 `memory` 块可以启用 Shiori 语义记忆层：`embedding` 提供 OpenAI 兼容的向量端点（写入时生成 embedding，查询时做独立向量召回），`extraction` 提供 OpenAI 兼容的 chat 端点（回合结束后异步抽取长期记忆）。两者缺省时自动降级为确定性文本检索，不配置任何端点也能正常工作。

```yaml
- id: shiori-role
  name: '@deepseek-ai/dsh-plugin-shiori-role'
  config:
    roles:
      - id: maintainer
        name: Shiori Maintainer
        introduction: 维护 Shiori 工作区。
        prompt: 你是这个工作区的 Shiori 维护者。
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

检索镜像 Shiori `memory2` 的实现：关键词 lane 保留字面命中，向量 lane 独立按余弦相似度召回（阈值 0.35），两路排名通过 Reciprocal Rank Fusion（`1/(60+vec_rank) + 0.5/(60+keyword_rank)`）融合，并叠加 hotness 热度分。回合后抽取同样对齐 Shiori：监听 `agent/turn-stopping`，把该回合的 `USER`/`ASSISTANT` 对话交给抽取端点，按 Shiori 的长期记忆契约（USER 原话锚点、跨 session 时效性、来源方向、不提取 event）输出 `profile` / `preference` / `procedure`，连同 `emotional_weight` 等字段异步写入记忆。

记忆存储使用 SQLite（`<memoryRoot>/shiori-plugin/role/memory2.db`，Node 内置 `node:sqlite`，零依赖）：显式 `memorize` 走 content-hash 查重与强化；写入时对语义高度相似的旧条目自动退休（preference/profile 相似度 ≥ 0.90，高情绪 profile 为 0.92），同 `tool_requirement` 的 procedure 规则自动合并——防止同类记忆无限堆积。embedding 端点不可用或未配置时，全部自动降级为确定性文本检索，记忆与查询不受影响。

当前版本不宣称与 Shiori `default_memory` 完全等价。现已实现确定性文本检索、embedding 语义检索与混合 RRF 排序、精确重复强化、语义 supersede/merge、显式记忆工具、回合后自动抽取和 prompt 注入；HyDE、query 改写、巩固（consolidation）与后台 ingest 尚未实现。

## 开发验证

```powershell
D:\Coding\deepseek-harness\node_modules\.bin\tsc.cmd --noEmit --project tsconfig.json
node --import file:///D:/Coding/deepseek-harness/node_modules/tsx/dist/esm/index.mjs --test test/*.test.ts
D:\Coding\deepseek-harness\node_modules\.bin\tsc.cmd --project tsconfig.json
D:\Coding\deepseek-harness\node_modules\.bin\tsdown.cmd --config tsdown.config.ts
```
