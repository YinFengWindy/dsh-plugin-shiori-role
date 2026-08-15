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

输入框可以在空白 Agent 创建前暂存角色选择。空白 Agent 在第一次组装 System Prompt 前仍可选择角色；插件会在模型执行前解析并持久化 pending 或工作区角色。会话没有选择角色且工作区也没有默认角色时会完全绕过插件，不注入角色 Prompt、Markdown 记忆上下文或角色记忆工具。已有会话一旦使用角色绑定便保持不可变，非空白会话不会热切换角色。

删除角色会执行物理删除：移除角色记录、所有 session 绑定、素材引用、Markdown 文件和角色独立的 SQLite memory2 数据库；已有会话也不会再恢复该角色。删除空白会话待选角色或工作区默认角色时，可变引用会改到目录中最早的剩余角色，并通过同一个 catalog 变更信号同步刷新所有插件 UI。

如果被删除角色拥有本地内容寻址图片素材，插件会在确认没有其他角色素材引用同一个 `sha256:` 对象后删除该附件文件。共享对象和非本地附件后端会保留；此 GC 不扫描角色目录之外的消息或 session 历史引用。

## 素材与主题

素材用途包括 `avatar`、`portrait`、`gallery` 和 `theme_background`。头像和立绘分别上传；图片二进制通过 `ctx.attachments.saveImage/readImage` 保存和读取，角色素材表只保存 attachment 引用。

当前会话角色控制输入框中的头像和名称。立绘可以通过插件自有 CSS 和 `ctx.theme.overrideTokens` 影响工作区与侧栏。插件释放时会清理注入的 stylesheet、主题覆盖、class、CSS 变量和图片 URL。

## 角色记忆

每个角色拥有隔离的持久记忆作用域，并由所有 DSH workspace 共享。可编辑角色定义保存在 `$DSH_HOME/shiori-plugin/role/<role-id>/role.json`；完整的角色可读投影位于 `$DSH_HOME/shiori-plugin/role/<role-id>/memory/`：`MEMORY.md` 保存长期事实、偏好与明确要求记住的内容，`HISTORY.md` 追加共同经历，`PENDING.md` 缓冲长期候选，`RECENT_CONTEXT.md` 保存最近话题与进行中事项，`SELF.md` 维护角色自我认知。相邻的 `memory2.db` 继续负责检索与结构化记忆。

Shiori 语义记忆层不配置 `memory` 块也会启用。每轮完成后，插件默认通过当前 Agent 的 Harness provider/model 发起一次有上限的独立请求，在回合关闭前抽取长期记忆；可选的 `extraction` 端点会覆盖这条默认调用。可选的 `embedding` 端点提供独立向量召回；未配置时检索降级为确定性文本匹配。

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

检索镜像 Shiori `memory2` 的实现：关键词 lane 保留字面命中，向量 lane 独立按余弦相似度召回（阈值 0.35），两路排名通过 Reciprocal Rank Fusion（`1/(60+vec_rank) + 0.5/(60+keyword_rank)`）融合，并叠加 hotness 热度分。回合后抽取同样对齐 Shiori：监听 `agent/turn-stopping`，把该回合的 `USER`/`ASSISTANT` 对话交给一次独立且有上限的模型请求，按 Shiori 的长期记忆契约（USER 原话锚点、跨 session 时效性、来源方向、不提取 event）输出 `profile` / `preference` / `procedure`。监听器会等待写入完成再关闭回合；抽取失败只记录日志，不会让已经完成的回复失败。变化后的记忆由 Harness 追加为 runtime-context 快照，保留此前可复用的请求 prefix。

记忆存储使用角色独立的 SQLite（`<memoryRoot>/shiori-plugin/role/<role-id>/memory/memory2.db`，Node 内置 `node:sqlite`，零依赖）：显式 `memorize` 走 content-hash 查重与强化；写入时对语义高度相似的旧条目自动退休（preference/profile 相似度 ≥ 0.90，高情绪 profile 为 0.92），同 `tool_requirement` 的 procedure 规则自动合并。Harness 成功压缩后，插件按照 `shadowedSeqs` 精确读取被压缩窗口，并按角色串行维护：追加 `history_entries` 与 `pending_items`，快照 `PENDING.md`，立即合并到 `MEMORY.md`，用同一批候选更新 `SELF.md`，生成 `RECENT_CONTEXT.md`，最后提交快照；optimizer 失败会回滚快照。SQLite 使用稳定的逐条 source ref 保存对应 event 和长期候选，并在整条流程成功后记录 compaction source ref，使重复投递直接跳过。`SELF.md`、`MEMORY.md` 与 `RECENT_CONTEXT.md` 的精简部分会注入角色上下文；`PENDING.md` 不注入，`HISTORY.md` 只作为可维护时间线。

当前版本不宣称与 Shiori `default_memory` 完全等价。现已实现确定性文本检索、embedding 语义检索与混合 RRF 排序、精确重复强化、语义 supersede/merge、显式记忆工具、回合后自动抽取、compaction 驱动的 Markdown consolidation、即时角色 optimizer 和 prompt 注入；HyDE、query 改写、定时 optimizer、journal 投影与后台 ingest 尚未实现。

## 开发验证

```powershell
D:\Coding\deepseek-harness\node_modules\.bin\tsc.cmd --noEmit --project tsconfig.json
node --import file:///D:/Coding/deepseek-harness/node_modules/tsx/dist/esm/index.mjs --test test/*.test.ts
D:\Coding\deepseek-harness\node_modules\.bin\tsc.cmd --project tsconfig.json
D:\Coding\deepseek-harness\node_modules\.bin\tsdown.cmd --config tsdown.config.ts
```
