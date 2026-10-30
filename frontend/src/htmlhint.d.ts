// htmlhint ships CommonJS without types for its browser build.
declare module "htmlhint" {
  export const HTMLHint: {
    verify(html: string, rules: Record<string, boolean>): { line: number; col: number; message: string; rule: { id: string } }[]
  }
}
