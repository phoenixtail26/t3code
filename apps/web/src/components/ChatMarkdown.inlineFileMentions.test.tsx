import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import ChatMarkdown from "./ChatMarkdown";

const CWD = "/repo/project";

function renderMarkdown(text: string): string {
  return renderToStaticMarkup(<ChatMarkdown text={text} cwd={CWD} />);
}

describe("ChatMarkdown inline code file mentions", () => {
  it("renders an inline code path as a clickable file chip", () => {
    const html = renderMarkdown("See `apps/web/src/main.tsx` for the entry point.");
    expect(html).toContain("chat-markdown-file-link");
    expect(html).toContain("main.tsx");
    expect(html).not.toContain("<code>apps/web/src/main.tsx</code>");
  });

  it("renders an inline code filename with line suffix as a chip with the line label", () => {
    const html = renderMarkdown("The handler lives in `ws.ts:840`.");
    expect(html).toContain("chat-markdown-file-link");
    expect(html).toContain("L840");
  });

  it("leaves non-file inline code as plain code", () => {
    const html = renderMarkdown("Use `console.log` and `arr.map` here.");
    expect(html).not.toContain("chat-markdown-file-link");
    expect(html).toContain("<code>console.log</code>");
    expect(html).toContain("<code>arr.map</code>");
  });

  it("leaves fenced code blocks untouched", () => {
    const html = renderMarkdown("```ts\nconst path = 'apps/web/src/main.tsx'\n```");
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("still renders markdown-link file paths as chips (existing behavior)", () => {
    const html = renderMarkdown("See [main](apps/web/src/main.tsx).");
    expect(html).toContain("chat-markdown-file-link");
  });

  it("does not process skill tokens inside inline code spans", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        text="Run $deploy or literally type `$deploy`."
        cwd={CWD}
        skills={[{ name: "deploy", displayName: "Deploy" }]}
      />,
    );
    // The prose token renders as a skill chip; the code-span token stays literal.
    expect(html).toContain('data-markdown-copy="$deploy"');
    expect(html).toContain("<code>$deploy</code>");
  });
});
