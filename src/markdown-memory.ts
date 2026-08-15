import type { MemoryChatClient } from './memory-engine/llm.ts'
import type { ConsolidatedEvent } from './semantic-consolidation.ts'
import { RoleFiles } from './role-files.ts'

const MERGE_SYSTEM = '你是中性的角色长期记忆整理器，不扮演角色，也不面向用户回复。你的工作不是概括对话，而是从记忆中剔除噪音，只保留对未来每次对话都产生底色影响的长期记忆。'

/** Shiori-compatible Markdown memory projection and optimizer. */
export class MarkdownMemory {
  constructor(private readonly files: RoleFiles) {}

  readPending(roleId: string): string {
    return this.files.readPending(roleId)
  }

  readRecentContext(roleId: string): string {
    return this.files.readRecentContext(roleId)
  }

  appendCompaction(roleId: string, sourceRef: string, events: readonly ConsolidatedEvent[], pending: string): void {
    this.files.appendHistory(roleId, sourceRef, events.map(event => event.summary))
    this.files.appendPending(roleId, sourceRef, pending)
  }

  snapshotPending(roleId: string): string {
    return this.files.snapshotPending(roleId)
  }

  commitPending(roleId: string): void {
    this.files.commitPendingSnapshot(roleId)
  }

  rollbackPending(roleId: string): void {
    this.files.rollbackPendingSnapshot(roleId)
  }

  async mergePending(roleId: string, pending: string, chat: MemoryChatClient): Promise<boolean> {
    if (!pending) return false
    const current = this.files.readMemory(roleId)
    const response = await chat.chat([
      { role: 'system', content: MERGE_SYSTEM },
      { role: 'user', content: mergePrompt(current, pending) },
    ], { maxTokens: 16_384, disableThinking: true, timeoutMs: 300_000 })
    if (!response.trim()) return false
    this.files.writeMemory(roleId, response)
    return true
  }

  context(roleId: string): string {
    const memory = this.files.readMemory(roleId)
    const recent = this.files.readRecentContext(roleId).split(/^## 最近的对话$/m)[0]!.trim()
    return [
      memory ? `## Long-term Memory\n\n${memory}` : '',
      recent ? `## Recent Context\n\n${recent}` : '',
    ].filter(Boolean).join('\n\n')
  }

  writeRecentContext(roleId: string, content: string): void {
    this.files.writeRecentContext(roleId, content)
  }
}

function mergePrompt(memory: string, pending: string): string {
  return `今日日期：${new Date().toISOString().slice(0, 10)}

你的任务是将「现有长期记忆」重新整理为一份精炼的长期记忆，同时合并「待合并事实」中的新内容。
正文必须使用当前角色相对视角：角色是“我”，交流对象是“你”，共同关系是“我们”。

## 核心判断标准：缺席成本测试
在 6 个月后的一次全新对话中，如果这条信息没有被注入，角色是否会在某个回复中出现方向性失误？是则保留，否则删除。

## 三种应保留的内容
- 关于你：你直接陈述或明确确认的稳定身份信息
- 你的偏好：你直接表达或明确确认的长期审美、交互禁忌和价值判断
- 你希望我记住的事：你明确要求“记住”或长期遵守的内容

待合并事实的 tag 含义：identity=稳定背景，preference=稳定偏好，key_info=允许保存的 key/token/id，health_long_term=长期健康事实，requested_memory=明确要求记住的内容，correction=对现有事实的纠正。

## 必须剔除
- 内网 IP、路由模式、运营商、MAC 等瞬时网络运维细节
- 时效性数字、版本变更叙事和瞬时情绪
- “最近”“这周”“目前”“正在”等短期状态（就读、实习、在职等社会角色可以保留）
- 伪装成用户偏好的 agent 执行规则、SOP、工具调用规范

## 整理原则
- 只对偏好类内容合并同类、上收方向；身份事实保留机构、部门、岗位、学校等具体信息
- 同类重复只保留最终版本
- correction 直接反映到最终内容，不保留旧值到新值的过程
- 不生成执行规则，不保留短期状态和事件流水账

## 输出格式
- 标题必须是 # 我的长期记忆
- 只允许 ## 关于你、## 你的偏好、## 你希望我记住的事
- 每条使用 bullet，1-2 行
- 正文只使用“我 / 你 / 我们”，不得写“用户 / 助手”
- 直接输出完整档案，不要 JSON、代码块或解释

现有长期记忆：
${memory || '（空）'}

待合并事实：
${pending}`
}
