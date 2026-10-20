import type { PyodideInterface } from "pyodide"

import { PYODIDE_VERSION } from "@/generated/pyodide"

/** The runtime is served from our own origin under a versioned, immutable path. */
export const PYODIDE_BASE = `/pyodide/v${PYODIDE_VERSION}/`
/** Packages built for Pyodide (micropip, numpy, jedi…) come from its CDN. */
export const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`

export type { PyodideInterface }

export async function bootPyodide(): Promise<PyodideInterface> {
  const { loadPyodide } = (await import(/* @vite-ignore */ `${PYODIDE_BASE}pyodide.mjs`)) as typeof import("pyodide")
  return loadPyodide({
    indexURL: PYODIDE_BASE,
    packageBaseUrl: PYODIDE_CDN,
    stdout: () => {},
    stderr: () => {},
  })
}

/** Writes bundled Python sources into the virtual filesystem as a package. */
export function installSources(py: PyodideInterface, pkg: string, files: Record<string, string>) {
  const dir = `/home/pyodide/${pkg}`
  py.FS.mkdirTree(dir)
  py.FS.writeFile(`${dir}/__init__.py`, "")
  for (const [name, source] of Object.entries(files)) py.FS.writeFile(`${dir}/${name}`, source)
}
