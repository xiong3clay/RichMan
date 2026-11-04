/**
 * Small DOM adapter for React lifecycle tests in Vitest's Node environment.
 * React owns rendering, hooks, value tracking and delegated event handling.
 * This adapter supplies only the DOM tree/events used by GameView; it does not
 * model layout, focus navigation or a complete browser. Mounts are sequential.
 */
import { act } from "react";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

interface DomEvent {
  type: string;
  target?: DomNode;
  bubbles: boolean;
  button?: number;
  defaultPrevented?: boolean;
  cancelBubble?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

type Listener = { type: string; callback: (event: DomEvent) => void; capture: boolean };

class DomNode {
  parentNode: DomNode | null = null;
  childNodes: DomNode[] = [];
  private listeners: Listener[] = [];

  constructor(readonly nodeType: number, public ownerDocument: DomDocument) {}

  get firstChild(): DomNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): DomNode | null { return this.childNodes.at(-1) ?? null; }
  get nextSibling(): DomNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings?.[siblings.indexOf(this) + 1] ?? null;
  }
  get textContent(): string { return this.childNodes.map(node => node.textContent).join(""); }
  set textContent(value: string) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    if (value !== "") this.appendChild(this.ownerDocument.createTextNode(value));
  }

  appendChild(node: DomNode): DomNode {
    node.parentNode?.removeChild(node);
    this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }
  insertBefore(node: DomNode, reference: DomNode | null): DomNode {
    if (reference === null) return this.appendChild(node);
    if (node === reference) return node;
    node.parentNode?.removeChild(node);
    const index = this.childNodes.indexOf(reference);
    if (index < 0) throw new Error("DOM reference is not a child");
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node: DomNode): DomNode {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error("DOM node is not a child");
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  contains(node: DomNode): boolean {
    return this === node || this.childNodes.some(child => child.contains(node));
  }

  addEventListener(type: string, callback: Listener["callback"], options?: boolean | { capture?: boolean }): void {
    this.listeners.push({ type, callback, capture: options === true || (typeof options === "object" && options.capture === true) });
  }
  removeEventListener(type: string, callback: Listener["callback"]): void {
    this.listeners = this.listeners.filter(listener => listener.type !== type || listener.callback !== callback);
  }
  dispatchEvent(event: DomEvent): boolean {
    event.target = this;
    const path: DomNode[] = [];
    for (let node: DomNode | null = this; node !== null; node = node.parentNode) path.push(node);
    const dispatch = (node: DomNode, capture: boolean): void => {
      for (const listener of node.listeners) {
        if (listener.type === event.type && listener.capture === capture) listener.callback(event);
      }
    };
    for (const node of [...path].reverse()) {
      dispatch(node, true);
      if (event.cancelBubble) return !event.defaultPrevented;
    }
    for (const node of path) {
      dispatch(node, false);
      if (event.cancelBubble || !event.bubbles) break;
    }
    return !event.defaultPrevented;
  }
}

class DomText extends DomNode {
  readonly nodeName = "#text";
  constructor(public nodeValue: string, document: DomDocument) { super(3, document); }
  override get textContent(): string { return this.nodeValue; }
  override set textContent(value: string) { this.nodeValue = value; }
}

export class DomElement extends DomNode {
  readonly tagName: string;
  readonly nodeName: string;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  private readonly attributes = new Map<string, string>();
  private inputValue = "";
  checked = false;
  defaultChecked = false;
  defaultValue = "";
  name = "";
  readonly style: Record<string, unknown> & { setProperty(name: string, value: string): void; removeProperty(name: string): void } = {
    setProperty(name, value) { this[name] = value; },
    removeProperty(name) { delete this[name]; },
  };

  constructor(readonly localName: string, document: DomDocument) {
    super(1, document);
    this.tagName = this.nodeName = localName.toUpperCase();
  }
  get value(): string { return this.inputValue; }
  set value(value: string) { this.inputValue = String(value); }
  get type(): string { return this.getAttribute("type") ?? (this.localName === "input" ? "text" : ""); }
  set type(value: string) { this.setAttribute("type", value); }
  get className(): string { return this.getAttribute("class") ?? ""; }
  get disabled(): boolean { return this.attributes.has("disabled"); }
  set disabled(value: boolean) { if (value) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  focus(): void { this.ownerDocument.activeElement = this; }

  querySelector(selector: string): DomElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): DomElement[] {
    // Deliberately support only simple tag/class/attribute and descendant selectors.
    const parts = selector.trim().match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) ?? [];
    const matches = (node: DomElement, part: string): boolean => {
      const tag = part.match(/^[\w-]+/);
      if (tag !== null && node.localName !== tag[0].toLowerCase()) return false;
      const classes = [...part.matchAll(/\.([\w-]+)/g)].map(match => match[1]!);
      if (classes.some(name => !node.className.split(/\s+/).includes(name))) return false;
      for (const attribute of part.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
        const actual = node.getAttribute(attribute[1]!);
        if (actual === null || (attribute[2] !== undefined && actual !== attribute[2])) return false;
      }
      const remaining = part.replace(/^[\w-]+/, "").replace(/\.[\w-]+/g, "").replace(/\[[^\]]+\]/g, "");
      if (remaining !== "" || part === "") throw new Error("Unsupported DOM selector: " + selector);
      return true;
    };
    const result: DomElement[] = [];
    const visit = (node: DomNode): void => {
      for (const child of node.childNodes) {
        if (child instanceof DomElement) {
          let index = parts.length - 1;
          if (index >= 0 && matches(child, parts[index]!)) {
            let ancestor = child.parentNode;
            while (index > 0 && ancestor !== null) {
              if (ancestor instanceof DomElement && matches(ancestor, parts[index - 1]!)) index -= 1;
              ancestor = ancestor.parentNode;
            }
            if (index === 0) result.push(child);
          }
        }
        visit(child);
      }
    };
    visit(this);
    return result;
  }
}

class DomDocument extends DomNode {
  readonly documentElement = new DomElement("html", this);
  readonly body = new DomElement("body", this);
  activeElement = this.body;
  oninput = null;
  defaultView: unknown;
  constructor() {
    super(9, undefined as unknown as DomDocument);
    this.ownerDocument = this;
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
  }
  createElement(name: string): DomElement { return new DomElement(name, this); }
  createElementNS(namespace: string, name: string): DomElement {
    const element = this.createElement(name);
    element.namespaceURI = namespace;
    return element;
  }
  createTextNode(value: string): DomText { return new DomText(value, this); }
}

function nativeEvent(type: string): DomEvent {
  return { type, bubbles: true, button: 0,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.cancelBubble = true; },
  };
}

let mounted = false;

export async function mountDom(element: ReactNode) {
  if (mounted) throw new Error("Clean up the previous DOM mount before mounting another");
  mounted = true;
  const document = new DomDocument();
  const window = { document, HTMLElement: DomElement, HTMLInputElement: DomElement, HTMLIFrameElement: class {}, Node: DomNode,
    addEventListener() {}, removeEventListener() {},
    setTimeout: (...args: Parameters<typeof globalThis.setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => globalThis.clearTimeout(timer),
    setInterval: (...args: Parameters<typeof globalThis.setInterval>) => globalThis.setInterval(...args),
    clearInterval: (timer: ReturnType<typeof globalThis.setInterval>) => globalThis.clearInterval(timer),
  };
  document.defaultView = window;
  const globals: Record<string, unknown> = { window, document, HTMLElement: DomElement, HTMLInputElement: DomElement,
    HTMLIFrameElement: window.HTMLIFrameElement, Node: DomNode, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const restore = (): void => {
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
    mounted = false;
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | undefined;
  try {
    // Import after installing the document so React detects native input events.
    const { createRoot } = await import("react-dom/client");
    root = createRoot(container as unknown as HTMLElement);
    await act(async () => root!.render(element));
  } catch (error) {
    try { if (root !== undefined) await act(async () => root!.unmount()); }
    finally { restore(); }
    throw error;
  }
  const matchingButtons = (text: string): DomElement[] => container.querySelectorAll("button").filter(button => button.textContent.includes(text));
  const clickElement = async (button: DomElement): Promise<void> => {
    if (!container.contains(button)) throw new Error("Click target is outside the mounted DOM");
    await act(async () => { if (!button.disabled) button.dispatchEvent(nativeEvent("click")); });
  };
  return {
    container,
    text: (): string => container.textContent,
    update: async (next: ReactNode): Promise<void> => { await act(async () => root!.render(next)); },
    click: async (text: string): Promise<void> => {
      const buttons = matchingButtons(text);
      if (buttons.length !== 1) throw new Error("Expected one button containing " + JSON.stringify(text) + ", found " + buttons.length);
      await clickElement(buttons[0]!);
    },
    clickAt: async (text: string, index: number): Promise<void> => {
      const button = matchingButtons(text)[index];
      if (button === undefined) throw new Error("Missing matching button at index " + index);
      await clickElement(button);
    },
    clickElement,
    input: async (placeholder: string, value: string): Promise<void> => {
      const inputs = container.querySelectorAll("input").filter(input => input.getAttribute("placeholder") === placeholder);
      if (inputs.length !== 1) throw new Error("Expected one input with placeholder " + JSON.stringify(placeholder));
      await act(async () => {
        // A user's native edit bypasses React's wrapper around the value setter.
        Object.getOwnPropertyDescriptor(DomElement.prototype, "value")!.set!.call(inputs[0], value);
        inputs[0]!.dispatchEvent(nativeEvent("input"));
      });
    },
    cleanup: async (): Promise<void> => {
      if (root === undefined) return;
      const current = root;
      root = undefined;
      try { await act(async () => current.unmount()); }
      finally { restore(); }
    },
  };
}
