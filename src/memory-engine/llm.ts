/**
 * OpenAI 兼容 LLM 客户端（chat + embeddings），镜像 `memory2/embedder.py`，
 * 统一 fetch 通道，带超时与批量。
 */

export interface LlmEndpointConfig {
  readonly endpoint: string
  readonly apiKey?: string | undefined
  readonly model: string
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

export interface ChatOptions {
  readonly maxTokens?: number
  readonly temperature?: number
  readonly disableThinking?: boolean
  readonly timeoutMs?: number
}

/** 简易 AbortSignal 超时封装（兼容非 Promise 值）。 */
function withTimeout<T>(promise: Promise<T> | T, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`shiori-role: ${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** OpenAI 兼容 chat completions 客户端。 */
export class ChatClient {
  private readonly url: string

  constructor(private readonly config: LlmEndpointConfig) {
    this.url = config.endpoint.replace(/\/$/, '') + '/chat/completions'
  }

  async chat(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.config.model,
      messages,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      ...(options.disableThinking === true ? { disable_thinking: true } : {}),
    }
    const timeoutMs = options.timeoutMs ?? 30_000
    const response = await withTimeout(fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
      body: JSON.stringify(payload),
    }), timeoutMs, 'chat request')
    if (!response.ok) throw new Error(`shiori-role: chat request failed (${response.status})`)
    const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('shiori-role: chat response is invalid')
    return content
  }
}

/** OpenAI 兼容 embeddings 客户端，镜像 `memory2/embedder.py`。 */
export class Embedder {
  static readonly MAX_BATCH = 10
  static readonly MAX_TEXT_LEN = 2000

  private readonly url: string
  private readonly model: string
  private readonly apiKey?: string
  private readonly outputDimensionality?: number

  constructor(config: LlmEndpointConfig, outputDimensionality?: number) {
    this.url = config.endpoint.replace(/\/$/, '') + '/embeddings'
    this.model = config.model
    if (config.apiKey !== undefined) this.apiKey = config.apiKey
    if (outputDimensionality !== undefined) this.outputDimensionality = outputDimensionality
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text])
    return results[0]!
  }

  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    const truncated = texts.map(text => text.slice(0, Embedder.MAX_TEXT_LEN))
    const results: number[][] = []
    for (let offset = 0; offset < truncated.length; offset += Embedder.MAX_BATCH) {
      const batch = truncated.slice(offset, offset + Embedder.MAX_BATCH)
      const payload: Record<string, unknown> = { model: this.model, input: batch }
      if (this.outputDimensionality !== undefined) payload.dimensions = this.outputDimensionality
      const response = await withTimeout(fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(payload),
      }), 40_000, 'embedding request')
      if (!response.ok) throw new Error(`shiori-role: embedding request failed (${response.status})`)
      const data = await response.json() as { data?: Array<{ index?: number; embedding?: unknown }> }
      const entries = [...(data.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      for (const entry of entries) {
        const embedding = entry.embedding
        if (!Array.isArray(embedding) || embedding.some(value => typeof value !== 'number')) {
          throw new Error('shiori-role: embedding response is invalid')
        }
        results.push(embedding as number[])
      }
      if (offset + Embedder.MAX_BATCH < truncated.length) {
        await new Promise(resolve => setTimeout(resolve, 300))
      }
    }
    return results
  }
}

/** cosine similarity with guard rails. */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!
    leftNorm += left[index]! ** 2
    rightNorm += right[index]! ** 2
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm)
}
