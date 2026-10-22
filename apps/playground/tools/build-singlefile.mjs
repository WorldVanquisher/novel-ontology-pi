/**
 * Builds the single-file edition of the playground: inlines the Vite
 * dist JS/CSS and embeds the local DB files (view.json + events.jsonl)
 * as script tags the app reads instead of fetching — so the page runs
 * fully offline from one HTML file.
 *
 * Run: npm run build && node tools/build-singlefile.mjs
 * Output: playground-live.html (project root of the app)
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
let html = readFileSync(join(dist, "index.html"), "utf8");

const assets = readdirSync(join(dist, "assets"));
const jsFile = assets.find((f) => f.endsWith(".js"));
const cssFile = assets.find((f) => f.endsWith(".css"));
const js = readFileSync(join(dist, "assets", jsFile), "utf8");
const css = readFileSync(join(dist, "assets", cssFile), "utf8");

// Replacement FUNCTIONS, not strings: String.replace would interpret
// $ patterns ($&, $', ...) in the bundle source and corrupt it.
html = html.replace(
  `<link rel="stylesheet" crossorigin href="/assets/${cssFile}">`,
  () => `<style>${css}</style>`,
);
html = html.replace(
  `<script type="module" crossorigin src="/assets/${jsFile}"></script>`,
  () => `<script type="module">${js}</script>`,
);
if (html.includes(`src="/assets/`) || html.includes(`href="/assets/`)) {
  throw new Error("unresolved asset references remain");
}

const view = readFileSync(join(root, "public", "db", "novel", "view.json"), "utf8");
const events = readFileSync(join(root, "public", "db", "novel", "events.jsonl"), "utf8");
const embed =
  `<script type="application/json" id="db-view">${view.replace(/<\/script/g, "<\\/script")}</script>\n` +
  `<script type="text/plain" id="db-events">${events.replace(/<\/script/g, "<\\/script")}</script>\n`;
html = html.replace("</body>", () => `${embed}</body>`);

const out = join(root, "playground-live.html");
writeFileSync(out, html);
console.log("single-file written:", out, `(${(html.length / 1024).toFixed(0)} KiB)`);
