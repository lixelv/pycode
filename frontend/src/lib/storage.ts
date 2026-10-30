const CODE_KEY = "python-coder:code"
const THEME_KEY = "polycode:theme"

export const DEFAULT_CODE = `# Welcome to polycode!
# Press Run (⌘/Ctrl + Enter) to execute, or Show tree to see the AST.

def greet(name: str) -> str:
    return f"Hello, {name}!"


name = input("What is your name? ")
print(greet(name))

squares = [n * n for n in range(1, 6)]
print("Squares:", squares)
`

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage may be unavailable (private mode, quota); nothing to do.
  }
}

export const loadCode = () => read(CODE_KEY) ?? DEFAULT_CODE
export const saveCode = (code: string) => write(CODE_KEY, code)

export type Theme = "dark" | "light"
export const loadTheme = (): Theme => (read(THEME_KEY) === "light" ? "light" : "dark")
export const saveTheme = (theme: Theme) => write(THEME_KEY, theme)
