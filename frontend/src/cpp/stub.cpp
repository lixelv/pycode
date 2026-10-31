// Linked into every C++ program (cpp.worker.ts compiles it once).
// The wasm sysroot has no exception runtime: `throw` would not link. These
// stand-ins print what g++ prints for an uncaught exception and abort, so
// `try/catch` compiles but never catches. The constructor moves to the
// entry's folder (wasi-libc starts in `/`).
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <typeinfo>
#include <unistd.h>

namespace __cxxabiv1 {
// libc++abi's type_info subclass: can_catch is the 3rd virtual after the destructor.
class __shim_type_info : public std::type_info {
public:
  ~__shim_type_info() override;
  virtual void noop1() const;
  virtual void noop2() const;
  virtual bool can_catch(const __shim_type_info*, void*&) const = 0;
};
}

extern "C" {
char* __cxa_demangle(const char*, char*, size_t*, int*);
void* __cxa_allocate_exception(size_t size) noexcept { return std::malloc(size); }
void __cxa_free_exception(void* p) noexcept { std::free(p); }
// Not <cxxabi.h>: its declaration (the wasm destructor returns void*) conflicts unless matched exactly.
void __cxa_throw(void* obj, std::type_info* t, void* (*)(void*)) {
  int st;
  char* n = __cxa_demangle(t->name(), nullptr, nullptr, &st);
  std::fflush(stdout);
  std::fprintf(stderr, "terminate called after throwing an instance of '%s'\n", n ? n : t->name());
  void* adj = obj;
  auto exc = static_cast<const __cxxabiv1::__shim_type_info*>(&typeid(std::exception));
  if (exc->can_catch(static_cast<const __cxxabiv1::__shim_type_info*>(t), adj))
    std::fprintf(stderr, "  what():  %s\n", static_cast<std::exception*>(adj)->what());
  std::abort();
}
}

__attribute__((constructor)) static void polycode_cwd() {
  if (const char* d = std::getenv("POLYCODE_CWD")) chdir(d);
}
