import { useEffect } from "react";
import { api } from "@/lib/api";

/* ------------------------------------------------------------------ *
 *  SeoManager — injects the admin-managed custom scripts/tags (Admin →
 *  Settings → SEO & Tracking Scripts) into the page on load:
 *    head   → appended to <head>
 *    body   → prepended to <body>
 *    footer → appended to <body>
 *  Renders nothing. Runs once per page load (SPA navigations don't
 *  re-run analytics snippets, matching how they behave on static sites).
 * ------------------------------------------------------------------ */

let injected = false;

/** Insert a raw HTML snippet so that <script> tags actually EXECUTE.
 *  (Scripts added via innerHTML are inert by spec — each one must be
 *  recreated as a real <script> element.) */
function injectHtml(target: Node, html: string, position: "append" | "prepend") {
  const trimmed = html.trim();
  if (!trimmed) return;
  const tpl = document.createElement("template");
  tpl.innerHTML = trimmed;
  const nodes: Node[] = [];
  for (const node of Array.from(tpl.content.childNodes)) {
    if (node instanceof HTMLScriptElement) {
      const s = document.createElement("script");
      for (const attr of Array.from(node.attributes)) s.setAttribute(attr.name, attr.value);
      s.text = node.text;
      nodes.push(s);
    } else {
      nodes.push(node);
    }
  }
  if (position === "prepend") {
    for (const n of nodes.reverse()) target.insertBefore(n, target.firstChild);
  } else {
    for (const n of nodes) target.appendChild(n);
  }
}

export function SeoManager() {
  useEffect(() => {
    if (injected) return;
    injected = true;
    api
      .config()
      .then(({ scripts }) => {
        if (!scripts) return;
        injectHtml(document.head, scripts.head, "append");
        injectHtml(document.body, scripts.body, "prepend");
        injectHtml(document.body, scripts.footer, "append");
      })
      .catch(() => {
        /* tracking tags are never worth breaking the app over */
      });
  }, []);

  return null;
}
