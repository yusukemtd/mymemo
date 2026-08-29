import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import {
  startCompletion,
  completionStatus,
  currentCompletions,
  completeAnyWord,
  CompletionContext,
} from "@codemirror/autocomplete";
import { createEditorState, setWordCompletion } from "./editor.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("単語補完", () => {
  it("completeAnyWord は文書内の単語(入力中の語を除く)を候補にする", () => {
    const state = createEditorState("banana apple\napricot ap", () => {});
    const result = completeAnyWord(new CompletionContext(state, state.doc.length, true));
    expect(result.options.map((o) => o.label).sort()).toEqual(["apple", "apricot", "banana"]);
    expect(result.from).toBe(state.doc.length - 2);
  });

  it("OFF(既定)では補完が始まらず、ON にすると候補が出る", async () => {
    setWordCompletion(false);
    const view = new EditorView({ state: createEditorState("banana apple\nap", () => {}), parent: document.body });
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(startCompletion(view)).toBe(false);
    expect(completionStatus(view.state)).toBeNull();

    view.dispatch({ effects: setWordCompletion(true)() });
    expect(startCompletion(view)).toBe(true);
    await wait(100);
    expect(completionStatus(view.state)).toBe("active");
    expect(currentCompletions(view.state).map((c) => c.label)).toEqual(["apple"]);
    setWordCompletion(false);
    view.destroy();
  });
});
