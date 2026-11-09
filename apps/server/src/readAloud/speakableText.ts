// Fork feature: read aloud. The words of a Markdown reply, for Hearsay's voice: code is
// dropped in silence, marks go and words stay, and line structure survives for Hearsay's
// sentence rule (a single line break is a space, a blank line ends a sentence, a line that
// starts with a number is its own sentence).

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?(?:[ \t]+(.*))?$/;
const TABLE_SEPARATOR = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:[ \t]*\S/;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function indentOf(line: string): number {
  let indent = 0;
  for (const char of line) {
    if (char === " ") indent += 1;
    else if (char === "\t") indent += 4;
    else break;
  }
  return indent;
}

/** One line's words: code spans keep their text, every other mark goes. */
function speakableInline(line: string): string {
  // Escaped characters and code spans are kept out of the way until every mark is handled.
  const literal: string[] = [];
  const keep = (text: string) => {
    literal.push(text);
    return `\u0000${literal.length - 1}\u0000`;
  };
  let text = line
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_match, char: string) => keep(char))
    .replace(/(`+)(.+?)\1/g, (_match, _ticks: string, code: string) => keep(code.trim()));
  text = text
    .replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/g, "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\[([^\]]+)\](?:\([^)]*\)|\[[^\]]*\])/g, "$1")
    .replace(/<(?:https?:\/\/[^>\s]+|[^@\s<>]+@[^@\s<>]+)>/g, "")
    .replace(/<\/?[a-zA-Z][^<>]*>/g, "")
    .replace(/(\*{1,3})(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(?<![\w\\])(_{1,3})(?=\S)(.*?\S)\1(?!\w)/g, "$2")
    .replace(/~~(?=\S)(.*?\S)~~/g, "$1")
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\\$/, "");
  text = text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => literal[Number(index)]!);
  return text.replace(/\s+/g, " ").trim();
}

function tableRow(line: string): string {
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => speakableInline(cell))
    .filter((cell) => cell.length > 0);
  return cells.join(", ");
}

/** The spoken words of a Markdown reply, one block per sentence group, code left out. */
export function speakableText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").replace(HTML_COMMENT, "").split("\n");
  const out: string[] = [];
  const blank = () => {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
  };
  // A heading is its own sentence; a list item or a table row starts one and its
  // continuation lines may join it.
  const block = (text: string, closed: boolean) => {
    if (text.length === 0) return;
    blank();
    out.push(text);
    if (closed) blank();
  };
  let fence: { readonly char: string; readonly length: number } | null = null;
  let afterBlank = true;
  let inIndentedCode = false;
  let inTable = false;
  let listIndent: number | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (fence) {
      const close = FENCE.exec(raw);
      if (
        close &&
        close[1]![0] === fence.char &&
        close[1]!.length >= fence.length &&
        !close[2]!.trim()
      )
        fence = null;
      continue;
    }
    const open = FENCE.exec(raw);
    if (open && (open[1]![0] === "~" || !open[2]!.includes("`"))) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      inIndentedCode = false;
      blank();
      afterBlank = true;
      continue;
    }
    const line = raw.replace(/^(?: {0,3}>[ ]?)+/, "");
    const quoted = line !== raw;
    if (line.trim().length === 0) {
      if (!inIndentedCode) blank();
      afterBlank = true;
      inTable = false;
      continue;
    }
    const indent = indentOf(line);
    const codeIndent = (listIndent ?? 0) + 4;
    if (inIndentedCode) {
      if (indent >= codeIndent) continue;
      inIndentedCode = false;
      blank();
    } else if (afterBlank && indent >= codeIndent && !quoted) {
      inIndentedCode = true;
      continue;
    }
    afterBlank = false;

    if (THEMATIC_BREAK.test(line) || LINK_DEFINITION.test(line)) {
      blank();
      afterBlank = true;
      listIndent = null;
      continue;
    }
    if (SETEXT_UNDERLINE.test(line) && out.length > 0 && out[out.length - 1] !== "") {
      blank();
      afterBlank = true;
      continue;
    }
    const heading = ATX_HEADING.exec(line);
    if (heading) {
      block(speakableInline(heading[1] ?? ""), true);
      afterBlank = true;
      listIndent = null;
      continue;
    }
    if (inTable && !line.includes("|")) inTable = false;
    if (line.includes("|") && !inTable && TABLE_SEPARATOR.test(lines[index + 1] ?? ""))
      inTable = true;
    if (inTable) {
      if (!TABLE_SEPARATOR.test(line)) block(tableRow(line), false);
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const [, lead, marker, rest = ""] = item;
      listIndent = indentOf(lead!) + marker!.length + 1;
      const text = speakableInline(rest);
      if (text.length === 0) continue;
      block(/^\d/.test(marker!) ? `${marker!.replace(")", ".")} ${text}` : text, false);
      continue;
    }
    if (listIndent !== null && indent < listIndent) listIndent = null;
    const text = speakableInline(line);
    if (text.length > 0) out.push(text);
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
