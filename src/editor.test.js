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

describe("Tab キー", () => {
  const press = (view, opts) =>
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, ...opts })
    );

  it("Tab でタブ文字が挿入される(フォーカス移動しない)", async () => {
    const { EditorView } = await import("@codemirror/view");
    const { createEditorState } = await import("./editor.js");
    const view = new EditorView({ state: createEditorState("ab", () => {}), parent: document.body });
    view.dispatch({ selection: { anchor: 1 } });
    const notDefaultPrevented = press(view, {});
    expect(notDefaultPrevented).toBe(false); // preventDefault された = エディタが処理した
    expect(view.state.doc.toString()).toBe("a\tb");
    view.destroy();
  });

  it("選択範囲があれば Tab で行がインデントされ、Shift+Tab で戻る", async () => {
    const { EditorView } = await import("@codemirror/view");
    const { createEditorState } = await import("./editor.js");
    const view = new EditorView({ state: createEditorState("a\nb", () => {}), parent: document.body });
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    press(view, {});
    expect(view.state.doc.toString()).toBe("    a\n    b");
    press(view, { shiftKey: true });
    expect(view.state.doc.toString()).toBe("a\nb");
    view.destroy();
  });
});
