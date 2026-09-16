import { useEffect } from "react";
import { api } from "@/lib/api";

// Injects the admin-managed SEO/tracking snippets (head/body/footer) once per page load.
// SPA navigations don't re-run them, same as on a static site.

let injected = false;

/** Insert raw HTML; scripts set via innerHTML are inert by spec, so each one is recreated as a real <script>. */
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
