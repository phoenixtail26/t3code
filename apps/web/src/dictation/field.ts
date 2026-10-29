// Fork feature: dictation. A text field outside the composer that dictation can
// target: the focused one when the shortcut fires, or the nearest to a
// DictationFieldButton. Insertion uses the native value setter plus an `input`
// event so a React controlled field sees it as typing.

export interface DictationField {
  readonly element: HTMLElement;
  /** Inserts at the field's selection; false when the field is gone or refused. */
  readonly insertAtSelection: (text: string) => boolean;
}

/** The input types that take free text and support `selectionStart`. */
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "tel"]);
const COMPOSER_EDITOR_SELECTOR = '[data-testid="composer-editor"]';
const FIELD_SELECTOR = "textarea, input, [contenteditable]";

function isTextControl(element: Element): element is HTMLTextAreaElement | HTMLInputElement {
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  if (element instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(element.type) && !element.disabled && !element.readOnly;
  }
  return false;
}

function isEditableHost(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const attribute = element.getAttribute("contenteditable");
  return attribute === "" || attribute === "true" || attribute === "plaintext-only";
}

/** The field behind an element, or null when it is not a field or is the composer's editor. */
function fieldFromElement(element: Element | null): DictationField | null {
  if (element === null || !(element instanceof HTMLElement)) return null;
  if (element.closest(COMPOSER_EDITOR_SELECTOR) !== null) return null;
  if (!isTextControl(element) && !isEditableHost(element)) return null;
  return { element, insertAtSelection: (text) => insertIntoField(element, text) };
}

/** The focused field outside the composer, or null when the composer or nothing has focus. */
export function captureFocusedField(): DictationField | null {
  return fieldFromElement(document.activeElement);
}

/** Walks up from `origin` to the first ancestor containing a field and returns that field. */
export function findNearestField(origin: Element | null): DictationField | null {
  for (let node = origin?.parentElement ?? null; node !== null; node = node.parentElement) {
    for (const candidate of node.querySelectorAll(FIELD_SELECTOR)) {
      const field = fieldFromElement(candidate);
      if (field !== null) return field;
    }
  }
  return null;
}

export function insertIntoField(element: HTMLElement, text: string): boolean {
  if (!element.isConnected) return false;
  if (isTextControl(element)) return insertIntoTextControl(element, text);
  if (isEditableHost(element)) return insertIntoEditableHost(element, text);
  return false;
}

/** A space on each side where the neighbouring character is not whitespace. */
function withBoundaries(before: string, text: string, after: string): string {
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.length > 0 && !/^\s/.test(after) ? " " : "";
  return `${lead}${text}${trail}`;
}

function insertIntoTextControl(element: HTMLTextAreaElement | HTMLInputElement, text: string) {
  const value = element.value;
  const start = element.selectionStart ?? value.length;
  const end = element.selectionEnd ?? start;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const inserted = withBoundaries(before, text, after);
  // React tracks the instance `value` to dedupe its own writes; setting through
  // the prototype bypasses that tracker so the `input` event reads as a change.
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter === undefined) return false;
  setter.call(element, `${before}${inserted}${after}`);
  const caret = before.length + inserted.length;
  element.setSelectionRange(caret, caret);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.focus();
  return true;
}

function insertIntoEditableHost(element: HTMLElement, text: string) {
  element.focus();
  const selection = element.ownerDocument.getSelection();
  let range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (range === null || !element.contains(range.commonAncestorContainer)) {
    range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  const inserted = withBoundaries(textBefore(range), text, textAfter(range));
  if (
    typeof document.execCommand === "function" &&
    document.execCommand("insertText", false, inserted)
  ) {
    return true;
  }
  range.deleteContents();
  const node = element.ownerDocument.createTextNode(inserted);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function textBefore(range: Range): string {
  const node = range.startContainer;
  return node.nodeType === Node.TEXT_NODE
    ? (node.textContent ?? "").slice(0, range.startOffset)
    : "";
}

function textAfter(range: Range): string {
  const node = range.endContainer;
  return node.nodeType === Node.TEXT_NODE ? (node.textContent ?? "").slice(range.endOffset) : "";
}
