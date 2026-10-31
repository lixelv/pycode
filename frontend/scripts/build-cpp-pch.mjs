// Precompiles src/cpp/pch.hpp into src/generated/std.pch, which cpp.worker.ts
// imports as a hashed asset. Takes about 10 s, so it is skipped while clang's
// version and the header are unchanged. Flags must match the worker's compile.
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const out = join(root, "src", "generated", "std.pch")
const stamp = `${out}.stamp`
const header = readFileSync(join(root, "src", "cpp", "pch.hpp"), "utf8")
const { version } = JSON.parse(readFileSync(join(root, "node_modules", "@yowasp", "clang", "package.json"), "utf8"))
const key = createHash("sha256").update(version).update(header).digest("hex")

if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, "utf8") === key) {
  console.log("C++ PCH is up to date")
} else {
  const { commands } = await import("@yowasp/clang")
  const files = await commands["clang++"](
    ["-std=c++20", "-fno-color-diagnostics", "-O1", "-x", "c++-header", "/std.hpp", "-o", "/std.hpp.pch"],
    { "std.hpp": header },
    { decodeASCII: false },
  )
  writeFileSync(out, files["std.hpp.pch"])
  writeFileSync(stamp, key)
  console.log("C++ PCH → src/generated/std.pch")
}
process.exit(0)
