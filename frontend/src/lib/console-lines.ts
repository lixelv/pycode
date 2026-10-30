/**
 * The line that explains an error ("ZeroDivisionError: division by zero",
 * clang's "main.cpp:4:3: error: …", the linker's "wasm-ld: error: …", an
 * uncaught C++ exception) is red; the rest of the traceback or the compiler's
 * context stays in the console's colours.
 */
export const ERROR_LINE =
  /^(?:[A-Za-z_][\w.]*(?:Error|Exception|Interrupt|Exit|Warning)\b(?::.*)?|\S+:\d+:\d+: (?:fatal )?error: .*|(?:wasm-ld|clang\+\+): error: .*|terminate called after throwing .*)$/

/**
 * Stderr text split into runs of error and other lines, newlines kept. A flood
 * of stderr has 100 000 lines: a DOM node per line would freeze the page.
 */
export function stderrRuns(text: string) {
  const runs: { error: boolean; text: string }[] = []
  for (const line of text.split(/(?<=\n)/)) {
    const error = ERROR_LINE.test(line.replace(/\n$/, ""))
    const last = runs.at(-1)
    if (last?.error === error) last.text += line
    else runs.push({ error, text: line })
  }
  return runs
}
