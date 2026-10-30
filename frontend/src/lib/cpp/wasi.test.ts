import { describe, expect, it } from "vitest";
import { Utf8Out } from "./wasi";

const encode = (text: string) => new TextEncoder().encode(text);

describe("Utf8Out", () => {
  it("decodes a letter split across two pushes", () => {
    const bytes = encode("Привет");
    // "П" is two bytes (D0 9F): cut between them.
    const out = new Utf8Out();
    const first = out.push(bytes.slice(0, 1));
    const second = out.push(bytes.slice(1));
    expect(first + second + out.flush()).toBe("Привет");
  });

  it("decodes a 4-byte emoji pushed one byte at a time", () => {
    const emoji = "😀";
    const bytes = encode(emoji);
    expect(bytes.length).toBe(4);
    const out = new Utf8Out();
    let text = "";
    for (const b of bytes) text += out.push(new Uint8Array([b]));
    expect(text + out.flush()).toBe(emoji);
  });

  it("flush turns a dangling lead byte into U+FFFD", () => {
    const out = new Utf8Out();
    expect(out.push(new Uint8Array([0xd0]))).toBe("");
    expect(out.flush()).toBe("�");
  });

  it("returns ASCII immediately", () => {
    const out = new Utf8Out();
    expect(out.push(encode("abc"))).toBe("abc");
  });
});
