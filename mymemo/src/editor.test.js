import { describe, it, expect } from "vitest";
import { detectLanguage } from "./editor.js";

describe("detectLanguage", () => {
  it("拡張子から言語を検出する", () => {
    expect(detectLanguage("/a/b/script.py")?.name).toBe("Python");
    expect(detectLanguage("main.rs")?.name).toBe("Rust");
    expect(detectLanguage("index.html")?.name).toBe("HTML");
    expect(detectLanguage("app.js")?.name).toBe("JavaScript");
  });

  it("未知の拡張子は null(プレーンテキスト)", () => {
    expect(detectLanguage("notes.unknownext")).toBeNull();
    expect(detectLanguage("README")).toBeNull();
  });

  it("path が null なら shebang がない限り null", () => {
    expect(detectLanguage(null)).toBeNull();
    expect(detectLanguage(null, "plain text")).toBeNull();
  });

  it("shebang から Python を検出する", () => {
    expect(detectLanguage(null, "#!/usr/bin/env python3")?.name).toBe("Python");
    expect(detectLanguage("script", "#!/usr/bin/python")?.name).toBe("Python");
  });

  it("shebang から Shell を検出する", () => {
    expect(detectLanguage(null, "#!/bin/bash")?.name).toBe("Shell");
    expect(detectLanguage(null, "#!/bin/sh")?.name).toBe("Shell");
    expect(detectLanguage(null, "#!/usr/bin/env zsh")?.name).toBe("Shell");
  });

  it("shebang 行でなければ shebang 判定しない", () => {
    expect(detectLanguage(null, "# python script")).toBeNull();
  });

  it("拡張子があるときは shebang より優先する", () => {
    expect(detectLanguage("tool.rs", "#!/usr/bin/env python3")?.name).toBe("Rust");
  });
});
