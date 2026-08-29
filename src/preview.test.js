import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
  convertFileSrc: (p) => `asset://localhost${p}`,
}));

import { sanitizeHtml, renderMarkdown } from "./preview.js";

describe("sanitizeHtml", () => {
  it("script などは中身ごと消し、イベント属性と javascript: リンクを落とす", () => {
    const out = sanitizeHtml(
      '<p>a<script>x()</script><style>p{}</style><iframe src="x"></iframe></p>' +
        '<img src="x" onerror="alert(1)"><a href="javascript:alert(1)" onclick="x()">l</a>' +
        "<!-- c -->"
    );
    expect(out).toBe("<p>a</p><a>l</a>");
  });

  it("許可外のタグは中身だけ残す", () => {
    expect(sanitizeHtml("<center><b>x</b><span style=\"color:red\">y</span></center>")).toBe("xy");
    expect(sanitizeHtml("<details><summary>s</summary><p>p</p></details>")).toBe("s<p>p</p>");
  });

  it("許可した属性だけ残す(href / src / align / class / checkbox / start)", () => {
    expect(sanitizeHtml('<a href="https://x.test/" title="t" target="_blank" rel="x">l</a>')).toBe(
      '<a href="https://x.test/" title="t">l</a>'
    );
    expect(sanitizeHtml('<a href="#top">l</a><a href="mailto:a@b.c">m</a>')).toBe(
      '<a href="#top">l</a><a href="mailto:a@b.c">m</a>'
    );
    expect(sanitizeHtml('<img src="data:image/png;base64,AAAA" alt="a" width="9">')).toBe(
      '<img src="data:image/png;base64,AAAA" alt="a">'
    );
    expect(sanitizeHtml('<td align="center" style="x">c</td>')).toBe("c"); // td 単体は tbody 補完で外れるので中身だけ
    expect(sanitizeHtml('<table><tr><td align="center" style="x">c</td></tr></table>')).toBe(
      '<table><tbody><tr><td align="center">c</td></tr></tbody></table>'
    );
    expect(sanitizeHtml('<pre><code class="language-js" data-x="1">c</code></pre>')).toBe(
      '<pre><code class="language-js">c</code></pre>'
    );
    expect(sanitizeHtml('<code class="evil">c</code>')).toBe("<code>c</code>");
    expect(sanitizeHtml('<input type="checkbox" checked onchange="x()"><input type="text">')).toBe(
      '<input type="checkbox" disabled="" checked="">'
    );
    expect(sanitizeHtml('<ol start="3" reversed><li>a</li></ol>')).toBe('<ol start="3"><li>a</li></ol>');
  });

  it("相対パスの画像は resolveSrc で解決し、解決できなければ外す。絶対パスとスキーム付きは通さない", () => {
    const resolveSrc = (src) => `asset://localhost/dir/${src}`;
    expect(sanitizeHtml('<img src="a b.png">', { resolveSrc })).toBe('<img src="asset://localhost/dir/a b.png">');
    expect(sanitizeHtml('<img src="a.png">')).toBe("");
    expect(sanitizeHtml('<img src="/etc/x.png">', { resolveSrc })).toBe("");
    expect(sanitizeHtml('<img src="file:///etc/x.png">', { resolveSrc })).toBe("");
  });
});

describe("renderMarkdown", () => {
  it("GFM(表・タスクリスト・取り消し線)を含めて HTML にし、サニタイズされる", () => {
    const html = renderMarkdown("# hi\n\n- [x] done\n\n| a |\n|---|\n| 1 |\n\n~~del~~ <script>x()</script>");
    expect(html).toContain("<h1>hi</h1>");
    expect(html).toContain('<input type="checkbox" disabled="" checked=""> done');
    expect(html).toContain("<table>");
    expect(html).toContain("<del>del</del>");
    expect(html).not.toContain("script");
  });

  it("相対パスの画像はファイルの場所から解決される", () => {
    const html = renderMarkdown("![p](img/a.png)", { resolveSrc: (s) => `asset://localhost/notes/${s}` });
    expect(html).toBe('<p><img src="asset://localhost/notes/img/a.png" alt="p"></p>\n');
  });
});
