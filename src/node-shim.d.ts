declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function readdirSync(path: string, options: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>
  export function renameSync(oldPath: string, newPath: string): void
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
  export function unlinkSync(path: string): void
  export function writeFileSync(path: string, data: string, encoding: 'utf8'): void
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function dirname(path: string): string
}

declare module 'node:os' {
  export function homedir(): string
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: string): Hash
    digest(encoding: 'hex'): string
  }
  export function createHash(algorithm: string): Hash
}

declare module 'node:sqlite' {
  export interface StatementResultingChanges {
    readonly changes: number | bigint
    readonly lastInsertRowid: number | bigint
  }
  export class StatementSync {
    run(...anonymousParameters: unknown[]): StatementResultingChanges
    get(...anonymousParameters: unknown[]): Record<string, unknown> | undefined
    all(...anonymousParameters: unknown[]): Record<string, unknown>[]
  }
  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}

declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>
}
