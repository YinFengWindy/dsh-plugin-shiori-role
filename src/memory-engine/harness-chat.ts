import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BlockAssembler,
  createUserMessage,
  type FinishReason,
  type GenerateOptions,
  type Message,
} from '@deepseek-ai/dsh-llm'
import type { ChatMessage, ChatOptions, MemoryChatClient } from './llm.ts'

const DEFAULT_TIMEOUT_MS = 30_000

export interface MemoryExtractionRequestEventData {
  readonly turn: number
  readonly roleId: string
  readonly route: { readonly provider: string; readonly model: string }
  readonly system: string
  readonly messages: Message[]
  readonly maxTokens: number
}

export interface SemanticMaintenanceRequestEventData {
  readonly roleId: string
  readonly purpose: 'self-seed' | 'consolidation' | 'recent-context' | 'memory-merge' | 'self-update'
  readonly sourceEventSeq?: number
  readonly route: { readonly provider: string; readonly model: string }
  readonly system: string
  readonly messages: Message[]
  readonly maxTokens: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact model request used to extract durable role memory after one turn. */
    'shiori-role/memory-extraction-request': MemoryExtractionRequestEventData
    /** Exact model request used for Shiori semantic consolidation or SELF maintenance. */
    'shiori-role/semantic-maintenance-request': SemanticMaintenanceRequestEventData
  }
}

/** One turn-bound auxiliary call through the Agent's current Harness model route. */
export class HarnessMemoryChatClient implements MemoryChatClient {
  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    private readonly turn: number,
    private readonly roleId: string,
    private readonly turnSignal: AbortSignal,
  ) {}

  async chat(input: readonly ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const route = resolveHarnessRoute(this.agent, this.turn)
    const system = input
      .filter(message => message.role === 'system')
      .map(message => message.content)
      .join('\n\n')
    const conversation = input
      .filter(message => message.role !== 'system')
      .map(message => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n')
    const messages: Message[] = [createUserMessage({
      content: [{ type: 'text', text: conversation }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-plugin-shiori-role' },
    })]
    const maxTokens = options.maxTokens ?? 600
    const signal = AbortSignal.any([
      this.turnSignal,
      AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ])
    const request: GenerateOptions = {
      ...route,
      messages,
      ...(system ? { system } : {}),
      maxTokens,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      sessionId: this.agent.session.id,
      signal,
    }
    this.agent.session.append('shiori-role/memory-extraction-request', {
      turn: this.turn,
      roleId: this.roleId,
      route,
      system,
      messages,
      maxTokens,
    })
    signal.throwIfAborted()
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream(request)) {
      signal.throwIfAborted()
      assembler.push(chunk)
    }
    signal.throwIfAborted()
    const error = finishError(assembler.finish)
    if (error !== undefined) throw error
    const blocks = assembler.blocks()
    if (blocks.some(block => block.type === 'tool-call')) {
      throw new Error('shiori-role: memory extraction model requested a tool')
    }
    const text = blocks
      .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
    if (!text) throw new Error('shiori-role: memory extraction model produced no text')
    return text
  }
}

/** Auxiliary Shiori maintenance call through a known Harness model route. */
export class HarnessSemanticChatClient implements MemoryChatClient {
  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    private readonly roleId: string,
    private readonly purpose: SemanticMaintenanceRequestEventData['purpose'],
    private readonly route: { readonly provider: string; readonly model: string },
    private readonly sourceEventSeq?: number,
  ) {}

  async chat(input: readonly ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const system = input.filter(message => message.role === 'system').map(message => message.content).join('\n\n')
    const conversation = input.filter(message => message.role !== 'system')
      .map(message => `${message.role.toUpperCase()}: ${message.content}`).join('\n')
    const messages: Message[] = [createUserMessage({
      content: [{ type: 'text', text: conversation }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-plugin-shiori-role' },
    })]
    const maxTokens = options.maxTokens ?? 2048
    const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this.agent.session.append('shiori-role/semantic-maintenance-request', {
      roleId: this.roleId,
      purpose: this.purpose,
      ...(this.sourceEventSeq === undefined ? {} : { sourceEventSeq: this.sourceEventSeq }),
      route: this.route,
      system,
      messages,
      maxTokens,
    })
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream({
      ...this.route,
      messages,
      ...(system ? { system } : {}),
      maxTokens,
      sessionId: this.agent.session.id,
      signal,
    })) assembler.push(chunk)
    const error = finishError(assembler.finish)
    if (error !== undefined) throw error
    const blocks = assembler.blocks()
    if (blocks.some(block => block.type === 'tool-call')) throw new Error('shiori-role: semantic maintenance model requested a tool')
    const text = blocks.filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
      .map(block => block.text).join('').trim()
    if (!text) throw new Error('shiori-role: semantic maintenance model produced no text')
    return text
  }
}

export function resolveHarnessRoute(agent: Agent, turn: number): { provider: string; model: string } {
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]!
    if (event.type === 'assistant/message' && event.data.turn === turn) {
      const source = event.data.message.source
      if (source.kind === 'model') return { provider: source.provider, model: source.model }
    }
  }
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]!
    if (event.type !== 'request/header') continue
    return { provider: event.data.header.config.provider, model: event.data.header.config.model }
  }
  const provider = agent.options.provider?.trim()
  const model = agent.options.model?.trim()
  if (!provider || !model) throw new Error('shiori-role: no model route is available for memory extraction')
  return { provider, model }
}

function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted':
      return new Error(finish.failure.message)
    case 'max-tokens':
      return new Error('shiori-role: memory extraction reached its output-token limit')
    case 'tool-calls':
      return new Error('shiori-role: memory extraction model requested a tool')
    default:
      return new Error(`shiori-role: unsupported extraction finish reason '${String((finish as { kind?: unknown }).kind)}'`)
  }
}
