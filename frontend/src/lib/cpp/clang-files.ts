import type { Tree } from "@yowasp/clang"

/** `{"/project/a/b.cpp": text}` → clang's nested tree. */
export function clangTree(files: Record<string, string | Uint8Array>): Tree {
  const root: Tree = {}
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/").filter(Boolean)
    let dir = root
    for (const part of parts.slice(0, -1)) dir = (dir[part] ??= {}) as Tree
    dir[parts.at(-1)!] = content
  }
  return root
}

/** The project and packages as clang sees them, and the `-I` flags for a file in it. */
export function clangInput(files: Record<string, string | Uint8Array>, entry: string, pkgs: { files: Record<string, string>; includes: string[] }) {
  const all: Record<string, string | Uint8Array> = { ...pkgs.files }
  for (const [path, content] of Object.entries(files)) all[`/project/${path}`] = content
  const folder = entry.includes("/") ? `/project/${entry.slice(0, entry.lastIndexOf("/"))}` : "/project"
  return { all, includes: [...new Set([folder, "/project"]), ...pkgs.includes].map((dir) => `-I${dir}`) }
}
