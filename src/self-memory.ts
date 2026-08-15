import type { ShioriRoleDefinition } from './types.ts'
import type { MemoryChatClient } from './memory-engine/llm.ts'
import { DEFAULT_SELF_MD, RoleFiles } from './role-files.ts'

const SELF_SECTIONS = ['## 我的性格与形象', '## 我对你的理解', '## 我们的关系'] as const

const SELF_SEED_SYSTEM = '你正在为一个新创建的角色生成首版 SELF.md。输出必须是角色自我认知，而不是用户档案、系统说明或设定复述。'

function selfSeedPrompt(role: ShioriRoleDefinition): string {
  return `请根据以下角色资料，为这个角色生成首版 \`SELF.md\`。

目标：
- 输出必须以 \`# 我是谁\` 开头
- 只允许包含三个 section：
  - \`## 我的性格与形象\`
  - \`## 我对你的理解\`
  - \`## 我们的关系\`

硬规则：
- 这是“当前角色”的自我认知，不是 Akashic 的说明
- 全文必须使用当前角色第一人称：角色写“我”，交流对象写“你”，共同关系写“我们”
- 每个 section 至少有一条以“我”或“我们”表达的 bullet；禁止用角色名称、“她/他/它”代替“我”
- 禁止出现“用户”“助手”“系统提示词”“AI”等旁观者或框架视角词
- 禁止出现“内部底座”“系统内核”“执行框架”“真实身份是 Akashic”“我只是外壳”这类元叙事
- 不要直接复述完整 system_prompt，要提炼成角色自述
- 还没有真实互动证据时，\`## 我对你的理解\` 必须克制，只能写谨慎、开放的初始理解
- 还没有真实互动证据时，\`## 我们的关系\` 只能写初始关系基调，不能虚构亲密经历
- 不要写用户偏好、时间线事件、工具规则、账号信息
- 输出语气要贴近角色自身，而不是通用助手模板

角色名称：
${role.name || role.id}

角色简介：
${role.introduction?.trim() || '（无）'}

角色背景：
（无）

角色系统提示词：
${role.prompt.trim()}`
}

const SELF_SYSTEM = '你正在整理当前角色的 SELF.md。你只能更新 SELF.md 中约定的三个 section，不得新增其他 section。禁止把角色写成 Akashic、系统底座、内部框架、执行内核或抽象工具。'

function selfUpdatePrompt(selfContent: string, pending: string): string {
  return `你的任务是根据当前 SELF.md 和本轮待合并事实，整理一份新的 SELF.md。

## 目标
- 只输出完整的 SELF.md
- 只允许保留以下三个 section：
  - \`## 我的性格与形象\`
  - \`## 我对你的理解\`
  - \`## 我们的关系\`
- 绝对禁止新增任何其他 section，尤其禁止出现 \`## 关系演进记录\`

## 更新原则
- 当前 SELF.md 是主文本，优先保留其已有的自我认知、语气和关系定义；不要把待合并事实机械改写进 SELF
- 全文必须保持当前角色第一人称：角色写“我”，交流对象写“你”，共同关系写“我们”；每个 section 至少保留一条“我/我们”视角的 bullet
- 禁止用角色名称、“她/他/它”旁观地描述当前角色，也禁止出现“用户”“助手”“系统提示词”“AI”等框架视角词
- 待合并事实只是辅助证据，只能在它们确实帮助澄清以下内容时少量吸收：
  - 当前角色的人格定位、说话风格、交互边界
  - 当前角色对用户的稳定理解
  - 当前角色与用户关系的长期定义
- 大多数待合并事实其实与 SELF.md 无关；无关时直接忽略，不要为了“有输入”而强行改写
- 尤其不要把以下内容写进 SELF.md：
  - 用户资料清单、账号、key、设备参数
  - 用户的具体审美偏好、消费偏好、工具偏好、画风偏好等条目本身
  - 健康状态、动态指标、短期计划、近期事件
  - 工具规范、SOP、调用规则、执行流程
  - 对话事件复盘、事件流水账、阶段性经历总结
- 不要把角色写成“内部底座”“系统本体”“真正身份是 Akashic”“我只是外壳”这类元叙事
- 不要把用户偏好直接抄进 \`## 我对当前用户的理解\`；只有当某条偏好已经稳定影响角色如何理解、靠近或回应用户时，才允许上收为更高层的关系理解
- 如果没有足够高价值的新信息，宁可输出与当前 SELF.md 基本一致的版本
- 保持语气稳定、简洁、有立场；它是自我认知，不是用户档案，也不是工作日志

## 输出约束
- 输出必须以 \`# 我是谁\` 开头
- 只能包含标题和 bullet 列表
- 不要代码块，不要解释，不要额外说明

---

当前 SELF.md：
${selfContent}

待合并事实：
${pending || '（无新内容）'}`
}

/** Shiori-compatible SELF.md seeding and maintenance. */
export class RoleSelfMemory {
  constructor(private readonly files: RoleFiles) {}

  read(roleId: string): string {
    return this.files.readSelf(roleId)
  }

  async seed(role: ShioriRoleDefinition, chat?: MemoryChatClient): Promise<boolean> {
    if (chat === undefined || this.files.readSelf(role.id).trim() !== DEFAULT_SELF_MD.trim()) return false
    const generated = (await chat.chat([
      { role: 'system', content: SELF_SEED_SYSTEM },
      { role: 'user', content: selfSeedPrompt(role) },
    ], { maxTokens: 2048, timeoutMs: 60_000 })).trim()
    if (!generated || !isRolePerspectiveDocument(generated)) return false
    this.files.writeSelf(role.id, generated)
    return true
  }

  async update(roleId: string, pending: string, chat: MemoryChatClient): Promise<boolean> {
    const current = this.files.readSelf(roleId).trim() || DEFAULT_SELF_MD.trim()
    const updated = (await chat.chat([
      { role: 'system', content: SELF_SYSTEM },
      { role: 'user', content: selfUpdatePrompt(current, pending) },
    ], { maxTokens: 2048, timeoutMs: 60_000 })).trim()
    if (!updated || !isRolePerspectiveDocument(updated)) return false
    this.files.writeSelf(roleId, updated)
    return true
  }
}

function isRolePerspectiveDocument(content: string): boolean {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  if (/用户|助手|系统提示词|\bAI\b|(?:^|[\s，。！？；：、])(?:她|他|它)(?:是|的|与|和|刚|会|很|在)/.test(normalized)) return false
  const lines = normalized.split('\n')
  if (lines[0] !== '# 我是谁') return false

  let sectionIndex = -1
  const bodies = SELF_SECTIONS.map(() => [] as string[])
  for (const line of lines.slice(1)) {
    const trimmed = line.trim()
    const matchingSection = SELF_SECTIONS.indexOf(trimmed as (typeof SELF_SECTIONS)[number])
    if (matchingSection !== -1) {
      if (matchingSection <= sectionIndex) return false
      sectionIndex = matchingSection
      continue
    }
    if (trimmed.startsWith('#')) return false
    if (sectionIndex === -1) {
      if (trimmed !== '') return false
      continue
    }
    if (trimmed !== '' && !/^[-*+]\s+/.test(trimmed)) return false
    bodies[sectionIndex]!.push(line)
  }
  return sectionIndex === SELF_SECTIONS.length - 1 && bodies.every((body, index) => {
    const text = body.join('\n').trim()
    return text !== '' && (index === 2 ? /我|我们/.test(text) : /我/.test(text))
  })
}
