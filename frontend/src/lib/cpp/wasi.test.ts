import { describe, expect, it } from "vitest";
import { Utf8Out, utf8Boundary } from "./wasi";

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

describe("utf8Boundary", () => {
  it("returns n for ASCII", () => {
    expect(utf8Boundary(encode("hello"), 3)).toBe(3);
  });

  it("moves back to the start of a 2-byte character cut in the middle", () => {
    const bytes = encode("aП"); // 61 D0 9F
    expect(utf8Boundary(bytes, 2)).toBe(1);
  });

  it("moves back to the start of a 4-byte character cut at any inner byte", () => {
    const bytes = encode("a😀b"); // 61 + 4 bytes + 62
    for (const n of [2, 3, 4]) expect(utf8Boundary(bytes, n)).toBe(1);
  });

  it("stays at a character boundary", () => {
    const bytes = encode("aП😀");
    expect(utf8Boundary(bytes, 1)).toBe(1);
    expect(utf8Boundary(bytes, 3)).toBe(3);
    expect(utf8Boundary(bytes, 7)).toBe(7);
  });

  it("returns the length when n is beyond it", () => {
    const bytes = encode("aП");
    expect(utf8Boundary(bytes, 100)).toBe(bytes.length);
  });

  it("returns 0 for n of 0", () => {
    expect(utf8Boundary(encode("П"), 0)).toBe(0);
  });

  it("the cut text never ends with U+FFFD", () => {
    const bytes = encode("😀😀😀");
    for (let n = 0; n <= bytes.length; n++) {
      expect(new TextDecoder().decode(bytes.slice(0, utf8Boundary(bytes, n)))).not.toContain("\uFFFD");
    }
  });
});
