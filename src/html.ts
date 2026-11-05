import { cover } from "./api";

/** Resolve upstream relative links without allowing script/data URLs or credentials. */
const SITE = "https://huangguoai.com/";
const TAGS = new Set([
  "p", "div", "span", "br", "hr", "strong", "em", "b", "i", "u", "s", "small", "sub", "sup",
  "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "code",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "figure", "figcaption", "a", "img",
]);
const DROP = new Set([
  "script", "style", "iframe", "object", "embed", "link", "meta", "base", "form", "input", "button",
  "textarea", "select", "option", "template", "noscript", "svg", "math", "video", "audio", "source",
]);

function safeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim(), SITE);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

/**
 * Build a fresh tree from an explicit tag/attribute allowlist. Upstream HTML shares
 * an origin with authenticated settings in the web version, so copying arbitrary
 * attributes (including CSS, namespaces or srcdoc) would be unsafe.
 */
export function sanitizeHtml(html: string): string {
  if (!html) return "";
  const source = new DOMParser().parseFromString(html, "text/html");
  const output = document.createElement("div");
  const append = (node: Node, parent: Node, depth: number) => {
    if (depth > 40) return;
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(node.textContent || ""));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.localName.toLowerCase();
    if (element.namespaceURI !== "http://www.w3.org/1999/xhtml" || DROP.has(tag)) return;
    if (!TAGS.has(tag)) {
      element.childNodes.forEach((child) => append(child, parent, depth + 1));
      return;
    }
    const clean = document.createElement(tag);
    const title = element.getAttribute("title");
    if (title) clean.setAttribute("title", title);
    if (tag === "img") {
      const raw = element.getAttribute("data-src") || element.getAttribute("data-original")
        || element.getAttribute("data-lazy-src") || element.getAttribute("src") || "";
      const url = raw ? safeUrl(raw) : "";
      if (!url) return;
      clean.setAttribute("src", cover(url));
      clean.setAttribute("alt", element.getAttribute("alt") || "");
      clean.setAttribute("loading", "lazy");
      clean.setAttribute("decoding", "async");
      clean.setAttribute("referrerpolicy", "no-referrer");
    } else if (tag === "a") {
      const raw = element.getAttribute("href") || "";
      const url = raw ? safeUrl(raw) : "";
      if (url) {
        clean.setAttribute("href", url);
        clean.setAttribute("target", "_blank");
        clean.setAttribute("rel", "noopener noreferrer");
      }
    } else if (tag === "td" || tag === "th") {
      for (const attribute of ["colspan", "rowspan"]) {
        const value = Number(element.getAttribute(attribute));
        if (Number.isInteger(value) && value >= 1 && value <= 100) clean.setAttribute(attribute, String(value));
      }
    }
    element.childNodes.forEach((child) => append(child, clean, depth + 1));
    parent.appendChild(clean);
  };
  source.body.childNodes.forEach((node) => append(node, output, 0));
  return output.innerHTML;
}

/** Compatibility entry point: image rewriting also enforces the HTML allowlist. */
export const proxyImages = sanitizeHtml;
