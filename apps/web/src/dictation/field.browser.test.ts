import { describe, expect, it } from "vite-plus/test";

import { captureFocusedField, findNearestField, insertIntoField } from "./field";

// Tests share one document; each one starts empty and leaves it empty.
function cleanBody(): Disposable {
  document.body.innerHTML = "";
  return { [Symbol.dispose]: () => void (document.body.innerHTML = "") };
}

function mountTextarea(value = "", selection?: [number, number]) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  document.body.appendChild(textarea);
  textarea.focus();
  if (selection) textarea.setSelectionRange(selection[0], selection[1]);
  return textarea;
}

describe("captureFocusedField", () => {
  it("captures a focused textarea outside the composer", () => {
    using _body = cleanBody();
    const textarea = mountTextarea();
    expect(captureFocusedField()?.element).toBe(textarea);
  });

  it("captures a focused text input and a contenteditable host", () => {
    using _body = cleanBody();
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.focus();
    expect(captureFocusedField()?.element).toBe(input);

    const host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    host.tabIndex = 0;
    document.body.appendChild(host);
    host.focus();
    expect(captureFocusedField()?.element).toBe(host);
  });

  it("returns null when the composer editor has focus, so the composer path runs", () => {
    using _body = cleanBody();
    const editor = document.createElement("div");
    editor.dataset.testid = "composer-editor";
    const host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    host.tabIndex = 0;
    editor.appendChild(host);
    document.body.appendChild(editor);
    host.focus();
    expect(captureFocusedField()).toBeNull();
  });

  it("returns null for the body, a button, a checkbox and a read-only textarea", () => {
    using _body = cleanBody();
    expect(captureFocusedField()).toBeNull();

    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    expect(captureFocusedField()).toBeNull();

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    document.body.appendChild(checkbox);
    checkbox.focus();
    expect(captureFocusedField()).toBeNull();

    const readOnly = mountTextarea();
    readOnly.readOnly = true;
    expect(captureFocusedField()).toBeNull();
  });
});

describe("insertIntoField", () => {
  it("inserts at the selection, moves the caret after the text and fires input", () => {
    using _body = cleanBody();
    const textarea = mountTextarea("alpha gamma", [6, 6]);
    const events: Array<string> = [];
    textarea.addEventListener("input", (event) => events.push(event.type));

    expect(insertIntoField(textarea, "beta")).toBe(true);
    expect(textarea.value).toBe("alpha beta gamma");
    expect(textarea.selectionStart).toBe(11);
    expect(textarea.selectionEnd).toBe(11);
    expect(events).toEqual(["input"]);
    expect(document.activeElement).toBe(textarea);
  });

  it("replaces a selection and adds a space on each side that touches a word", () => {
    using _body = cleanBody();
    const textarea = mountTextarea("one XXX two", [4, 7]);
    expect(insertIntoField(textarea, "and")).toBe(true);
    expect(textarea.value).toBe("one and two");

    const tight = mountTextarea("ab", [1, 1]);
    expect(insertIntoField(tight, "mid")).toBe(true);
    expect(tight.value).toBe("a mid b");
  });

  it("bypasses React's instance value tracker so the input event reads as a change", () => {
    using _body = cleanBody();
    const textarea = mountTextarea("", [0, 0]);
    // React defines an own `value` property on the node to remember what it
    // last wrote; a write through that property would make it ignore the event.
    let tracked = "";
    Object.defineProperty(textarea, "value", {
      configurable: true,
      get: () =>
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.get!.call(
          textarea,
        ),
      set: (next: string) => {
        tracked = next;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          textarea,
          next,
        );
      },
    });
    expect(insertIntoField(textarea, "spoken")).toBe(true);
    expect(textarea.value).toBe("spoken");
    expect(tracked).toBe("");
  });

  it("refuses a detached field", () => {
    using _body = cleanBody();
    const textarea = mountTextarea("keep");
    const field = captureFocusedField();
    textarea.remove();
    expect(field?.insertAtSelection("more")).toBe(false);
    expect(textarea.value).toBe("keep");
  });

  it("inserts into a contenteditable host at its selection", () => {
    using _body = cleanBody();
    const host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    host.tabIndex = 0;
    host.textContent = "hello world";
    document.body.appendChild(host);
    host.focus();
    const range = document.createRange();
    range.setStart(host.firstChild!, 5);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(insertIntoField(host, "there")).toBe(true);
    expect(host.textContent).toBe("hello there world");
  });
});

describe("findNearestField", () => {
  it("finds the textarea in the nearest ancestor that has one", () => {
    using _body = cleanBody();
    document.body.innerHTML = `
      <textarea id="outer"></textarea>
      <div id="popover">
        <textarea id="inner"></textarea>
        <div class="row"><span id="host"></span></div>
      </div>`;
    const host = document.getElementById("host");
    expect(findNearestField(host)?.element.id).toBe("inner");
  });

  it("returns null when no ancestor holds a field", () => {
    using _body = cleanBody();
    document.body.innerHTML = `<div><span id="host"></span></div>`;
    expect(findNearestField(document.getElementById("host"))).toBeNull();
  });
});
