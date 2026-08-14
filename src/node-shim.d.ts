declare module 'node:fs' {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function readdirSync(path: string, options: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>
  export function unlinkSync(path: string): void
  export function writeFileSync(path: string, data: string, encoding: 'utf8'): void
}

declare module 'node:path' {
  export function join(...parts: string[]): string
}

declare module 'node:os' {
  export function homedir(): string
}

declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>
}
