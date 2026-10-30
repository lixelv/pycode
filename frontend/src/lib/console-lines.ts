/**
 * The line that explains an error ("ZeroDivisionError: division by zero",
 * clang's "main.cpp:4:3: error: …", the linker's "wasm-ld: error: …", an
 * uncaught C++ exception) is red; the rest of the traceback or the compiler's
 * context stays in the console's colours.
 */
export const ERROR_LINE =
  /^(?:[A-Za-z_][\w.]*(?:Error|Exception|Interrupt|Exit|Warning)\b(?::.*)?|\S+:\d+:\d+: (?:fatal )?error: .*|(?:wasm-ld|clang\+\+): error: .*|terminate called after throwing .*)$/
