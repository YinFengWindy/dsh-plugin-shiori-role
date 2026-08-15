import type { MemoryChatClient } from './memory-engine/llm.ts'

export interface ConsolidatedEvent {
  readonly summary: string
  readonly emotionalWeight: number
}

export interface SemanticConsolidation {
  readonly events: readonly ConsolidatedEvent[]
  readonly candidates: readonly ConsolidatedCandidate[]
  readonly pending: string
}

export interface ConsolidatedCandidate {
  readonly tag: 'identity' | 'preference' | 'key_info' | 'health_long_term' | 'requested_memory' | 'correction'
  readonly content: string
}

export interface RecentContextInput {
  readonly previous: string
  readonly conversation: string
  readonly recentTurns: string
  readonly until: string
}

const CONSOLIDATION_SYSTEM = '你是中性的 Markdown 记忆提取器，不扮演角色，也不生成用户可见回复。USER 是当前角色交流对象“你”，ASSISTANT 是当前角色“我”。自然语言输出必须使用“我 / 你 / 我们”。'
const PENDING_TAGS = new Set<ConsolidatedCandidate['tag']>([
  'identity', 'preference', 'key_info', 'health_long_term', 'requested_memory', 'correction',
])

function consolidationPrompt(conversation: string, existingMemory: string): string {
  return `从对话中精确提取结构化信息，返回 JSON。

## 字段说明

### 1. "history_entries"（数组，每条对应一个独立主题）
按主题拆分，每个独立话题写一条对象，格式为 {"summary":"...", "emotional_weight":0}。
summary 要求 1-2 句，以 [YYYY-MM-DD HH:MM] 开头，保留足够细节便于未来检索。不同主题必须拆成独立条目。

history_entries.emotional_weight 规则：
- 范围 0-10
- 普通技术讨论、普通事务记录、无明显情绪色彩 → 0
- 你明确表达强烈喜欢/厌恶、明显受挫、关系冲突、情绪波动时按强度给 3-9
- 不确定时保守输出 0

history_entries 提取规则（严格遵守）：
1. 只提取 USER 明确表达的行动、经历、计划和状态；ASSISTANT 的建议、推荐、解释一律不写入。
2. 每条必须使用角色相对视角：当前角色是“我”，USER 是“你”，共同关系是“我们”；不得包含 USER: 或 ASSISTANT: 标记，不得复制原始对话。
3. 商家名称、地点、人名、数量、价格、型号等具体细节必须保留。
4. 先判断 USER 内容是用户直接自述，还是外部聊天记录、截图 OCR、转贴 transcript。
5. 外部材料中的 speaker 不自动等于当前 USER；只有映射被明确确认时才能归因。
6. speaker 映射不明确时，只允许写一条高层 event，例如“你向我展示了一段与某人的聊天记录，内容涉及求职、学校、兴趣等话题”。
7. transcript 场景默认最多输出一条高层 history_entry，不得下钻成人物小传或推断身份关系。

### 2. "pending_items"（长期记忆候选缓冲）
只写用户的长期记忆候选，返回对象数组：{"tag":"<tag>", "content":"<string>"}。

允许的 tag 只有：
- identity：稳定背景事实，如身份、学校/专业、长期技术方向、实习/工作经历、长期设备、长期维护项目
- preference：稳定偏好、禁忌、审美、游戏口味、价值取向
- key_info：用户明确允许保存的 key / token / id / 账号信息
- health_long_term：长期健康状态的一阶事实
- requested_memory：用户明确要求长期记住的关键内容
- correction：对已有长期事实的明确纠正

必须遵守：
- 只写跨对话仍有长期价值的内容
- 不写 agent 执行规则、SOP、工具调用顺序、流程规范
- 不写短期状态、近期计划、日程、课表、一次性操作
- 不写动态健康数据、实时指标、最近状态
- 不写对话过程总结、self_insights、行为规律总结、关系演进感悟
- requested_memory 只能在用户明确表达“记住这个 / 写进长期记忆 / 以后要能聊到 / 希望你记住”时使用
- 内网 IP、路由模式、运营商名称、MAC 地址等瞬时网络配置不提取
- 带“最近”“这周”“目前”“正在”等限定的瞬时状态不提取；规律性习惯可以提取
- 时效性数字和瞬时情绪不提取；可以保留背后的稳定价值判断
- 描述 agent 如何执行任务的内容属于 procedure，不放入 pending_items

若没有合格条目，返回空数组。

## 当前长期记忆（用于查重）
${existingMemory || '（空）'}

## 待处理对话
${conversation}

只返回合法 JSON，不要 markdown 代码块。`
}

/** Run Shiori's consolidation extraction over one Harness compaction window. */
export async function consolidateSemantics(
  conversation: string,
  existingMemory: string,
  chat: MemoryChatClient,
): Promise<SemanticConsolidation> {
  const raw = await chat.chat([
    { role: 'system', content: CONSOLIDATION_SYSTEM },
    { role: 'user', content: consolidationPrompt(conversation, existingMemory) },
  ], { maxTokens: 1024, disableThinking: true, timeoutMs: 300_000 })
  const payload = parseObject(raw)
  const history = Array.isArray(payload.history_entries) ? payload.history_entries : []
  const events = history.flatMap(candidate => {
    if (typeof candidate !== 'object' || candidate === null) return []
    const item = candidate as Record<string, unknown>
    const summary = typeof item.summary === 'string' ? item.summary.trim() : ''
    if (!summary) return []
    const weight = Number(item.emotional_weight ?? 0)
    return [{ summary, emotionalWeight: Number.isFinite(weight) ? Math.max(0, Math.min(10, Math.trunc(weight))) : 0 }]
  })
  const pendingItems = Array.isArray(payload.pending_items) ? payload.pending_items : []
  const candidates = pendingItems.flatMap(candidate => {
    if (typeof candidate !== 'object' || candidate === null) return []
    const item = candidate as Record<string, unknown>
    const tag = typeof item.tag === 'string' ? item.tag.trim() : ''
    const content = typeof item.content === 'string' ? item.content.trim() : ''
    if (!PENDING_TAGS.has(tag as ConsolidatedCandidate['tag']) || !content) return []
    return [{ tag: tag as ConsolidatedCandidate['tag'], content }]
  })
  const pending = candidates.map(candidate => `- [${candidate.tag}] ${candidate.content}`).join('\n')
  return { events, candidates, pending }
}

/** Generate Shiori's conservative RECENT_CONTEXT.md projection. */
export async function consolidateRecentContext(input: RecentContextInput, chat: MemoryChatClient): Promise<string> {
  const raw = await chat.chat([
    { role: 'system', content: '你是近期语境压缩代理，只返回合法 JSON。' },
    { role: 'user', content: recentContextPrompt(input) },
  ], { maxTokens: 512, disableThinking: true, timeoutMs: 300_000 })
  const payload = parseObject(raw)
  const values = (key: string) => Array.isArray(payload[key])
    ? payload[key].filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim()).slice(0, 3)
    : []
  const lines = ['# 最近发生的事', '', '## 最近聊过的事', `until: ${input.until || 'none'}`]
  const groups: readonly [string, string][] = [
    ['最近持续关注', 'active_topics'], ['最近明确偏好', 'user_preferences'],
    ['最近待延续话题', 'follow_ups'], ['最近避免事项', 'avoidances'],
  ]
  let found = false
  for (const [title, key] of groups) {
    const items = values(key)
    if (items.length === 0) continue
    found = true
    lines.push(`- ${title}：${items.join('；')}`)
  }
  if (!found) lines.push('- none')
  lines.push('', '## 还在继续的事')
  const ongoing = values('ongoing_threads')
  lines.push(...(ongoing.length > 0 ? ongoing.map(item => `- ${item}`) : ['- none']))
  lines.push('', '## 最近的对话', '<!-- a-preview = assistant reply preview only -->', input.recentTurns.trim() || '- none')
  return lines.join('\n').trim() + '\n'
}

function recentContextPrompt(input: RecentContextInput): string {
  return `你是近期语境压缩代理。你的任务不是自由总结，而是为后续角色行为保守地抽取近期语境。

规则：
- 只允许依据 USER 明确表达过的内容输出；ASSISTANT 的建议、解释、命名、延伸不得当作证据
- active_topics 和 follow_ups 写用户最近实际讨论的话题，不要升级为长期偏好
- user_preferences 只有 USER 明确出现“喜欢、偏好、希望、别、不要、避免、不想”时才填写
- avoidances 只有 USER 明确表达否定或回避时才填写
- ongoing_threads 只记录对用户生活、情绪、工作、学习、关系或健康有持续影响的重要事情；普通技术讨论不得写入
- 只保留未来几轮仍有用的信息；没有把握就留空
- 每个字段最多 3 条

上一版 recent context：
${input.previous || '（空）'}

较早窗口：
${input.conversation || '（空）'}

最新 recent turns：
${input.recentTurns || '（空）'}

只返回 JSON：
{"active_topics":[],"user_preferences":[],"follow_ups":[],"avoidances":[],"ongoing_threads":[]}`
}

function parseObject(raw: string): Record<string, unknown> {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('shiori-role: consolidation returned invalid JSON')
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('shiori-role: consolidation returned a non-object JSON value')
  }
  return parsed as Record<string, unknown>
}
