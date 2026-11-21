// After `vite build`, render every page to static HTML so search engines and
// visitors without JavaScript get the full page. Output names suit Cloudflare
// Pages: /features is served from features.html, unknown paths from 404.html.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const ssr = new URL("../dist-ssr/entry-server.js", import.meta.url);
const { render, PAGES, NOT_FOUND } = await import(ssr.href);
// Inline the one stylesheet so the first paint needs no extra request.
let template = readFileSync(dist + "index.html", "utf8");
const cssLink = template.match(/<link rel="stylesheet" crossorigin href="\/(assets\/[^"]+\.css)">/);
if (!cssLink) throw new Error("stylesheet link not found in dist/index.html");
const css = readFileSync(dist + cssLink[1], "utf8").replace(/<\/style/gi, "<\\/style");
template = template.replace(cssLink[0], () => `<style>${css}</style>`);
const SITE = "https://kahoai.in";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function page(meta, url) {
  const href = SITE + (meta.path === "/404" ? "/" : meta.path);
  let html = template
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(meta.title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*/, `$1${esc(meta.description)}`)
    .replace(/(<meta property="og:title" content=")[^"]*/, `$1${esc(meta.title)}`)
    .replace(/(<meta property="og:description" content=")[^"]*/, `$1${esc(meta.description)}`)
    .replace(/(<meta property="og:url" content=")[^"]*/, `$1${href}`)
    .replace(/(<link rel="canonical" href=")[^"]*/, `$1${href}`)
    .replace('<meta name="robots" content="index, follow">', `<meta name="robots" content="${meta.noindex ? "noindex, follow" : "index, follow"}">`);
  if (!html.includes("<!--app-html-->")) throw new Error("template has no <!--app-html--> placeholder");
  return html.replace("<!--app-html-->", render(url));
}

const out = { "/": "index.html" };
for (const meta of PAGES) {
  const file = out[meta.path] || meta.path.slice(1) + ".html";
  writeFileSync(dist + file, page(meta, meta.path));
  console.log("prerendered", meta.path, "->", file);
}
writeFileSync(dist + "404.html", page(NOT_FOUND, "/this-page-does-not-exist"));
console.log("prerendered 404 -> 404.html");
rmSync(fileURLToPath(new URL("../dist-ssr/", import.meta.url)), { recursive: true, force: true });
