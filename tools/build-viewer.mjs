/**
 * Build a single-file viewer edition of the System 1 design site.
 *
 * Why: the canonical site is one file per sector page (docs/system1/*.html)
 * and only works when the whole folder is served/opened together — chat
 * previews and GitHub's source view serve a single file, so relative
 * page links error there. This script inlines the shared CSS/JS into
 * every page and packages all pages into ONE html file where each page
 * runs isolated in a frame and the top nav switches between them.
 * Clicking works from a single downloaded/opened file.
 *
 * Usage: node tools/build-viewer.mjs
 * Output: docs/system1-viewer.html (generated — do not edit by hand)
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(root, "docs", "system1");

const css = await readFile(join(site, "assets", "style.css"), "utf8");
const sectorJs = await readFile(join(site, "assets", "sector.js"), "utf8");

const PAGES = [
  "index.html",
  "roadmap.html",
  "playground-frontend.html",
  "sectioning.html",
  "scene-boundary.html",
  "dialogue-detector.html",
  "name-detector.html",
  "presence-detector.html",
  "speaker-attribution.html",
  "miniloop-engine.html",
  "extraction.html",
  "merge-gate.html",
  "storage-connectors.html",
  "timeline-forking.html",
  "simulation.html",
];

const BRIDGE = `
document.addEventListener('click', function (e) {
  var a = e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  var h = a.getAttribute('href');
  if (!h || h.indexOf('http') === 0 || h.charAt(0) === '#') return;
  e.preventDefault();
  parent.postMessage({ nav: h }, '*');
}, true);`;

const HIDE_CHROME = "#sitenav, #pager { display: none !important; } body { padding-top: 4px; }";

const pages = {};
for (const name of PAGES) {
  let html = await readFile(join(site, name), "utf8");
  html = html.replace(
    '<link rel="stylesheet" href="assets/style.css">',
    `<style>\n${css}\n${HIDE_CHROME}\n</style>`,
  );
  html = html.replace(
    '<script src="assets/sector.js"></script>',
    `<script>\n${sectorJs}\n</script>`,
  );
  // Any page-specific external script (none in sector pages today) would
  // need inlining too; fail loudly instead of shipping a broken viewer.
  const leftover = html.match(/<script src="([^"]+)"/);
  if (leftover) throw new Error(`${name}: un-inlined script ${leftover[1]}`);
  html = html.replace("</body>", `<script>${BRIDGE}</script>\n</body>`);
  pages[name] = html;
}

const shell = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>System 1 design — single-file viewer · novel-ontology-pi</title>
<style>
  body{margin:0;background:#0b0e14;color:#e8ecf4;font:14px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif}
  header{position:sticky;top:0;z-index:10;background:#0d1220;border-bottom:1px solid #26304a;
    padding:8px 12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  header b{margin-right:10px}
  header small{color:#5f6d88;display:block;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase}
  button{background:#171e2e;color:#9aa7bd;border:1px solid #26304a;border-radius:99px;
    padding:4px 11px;font-size:12.5px;cursor:pointer;white-space:nowrap}
  button:hover{color:#e8ecf4;border-color:#2dd4bf}
  button.here{background:#2dd4bf;color:#0b0e14;border-color:#2dd4bf;font-weight:600}
  iframe{width:100%;height:calc(100vh - 57px);border:0;display:block;background:#0b0e14}
  #note{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);background:#171e2e;
    border:1px solid #fbbf24;color:#e8ecf4;border-radius:10px;padding:8px 14px;font-size:13px;
    display:none;z-index:20}
</style>
</head>
<body>
<header id="bar"></header>
<iframe id="frame" title="System 1 design page"></iframe>
<div id="note"></div>
<script>
const PAGES = ${JSON.stringify(pages).replace(/<\/script/gi, "<\\/script")};
const ORDER = ${JSON.stringify(PAGES)};
const LABELS = { "index.html": "Overview", "roadmap.html": "🗺 Roadmap", "playground-frontend.html": "13 Playground", "sectioning.html": "01 Sectioning",
  "scene-boundary.html": "02 Scene boundary", "dialogue-detector.html": "03 Dialogue",
  "name-detector.html": "04 Names", "presence-detector.html": "05 Presence",
  "speaker-attribution.html": "06 Speakers", "miniloop-engine.html": "07 Miniloop engine",
  "extraction.html": "08 Extraction", "merge-gate.html": "09 Merge gate",
  "storage-connectors.html": "10 Storage", "timeline-forking.html": "11 Timelines & forks",
  "simulation.html": "12 Simulation" };
const bar = document.getElementById('bar');
const frame = document.getElementById('frame');
bar.innerHTML = '<b>novel-ontology-pi<small>System 1 · single-file viewer</small></b>' +
  ORDER.map(p => '<button data-p="' + p + '">' + LABELS[p] + '</button>').join('');
function go(p) {
  if (!PAGES[p]) { note('That link points to DESIGN.md in the repo — not part of this viewer.'); return; }
  frame.srcdoc = PAGES[p];
  document.querySelectorAll('#bar button').forEach(b => b.classList.toggle('here', b.dataset.p === p));
  if (location.hash !== '#' + p) history.replaceState(null, '', '#' + p);
}
let noteTimer;
function note(msg) {
  const n = document.getElementById('note');
  n.textContent = msg; n.style.display = 'block';
  clearTimeout(noteTimer); noteTimer = setTimeout(() => n.style.display = 'none', 3500);
}
bar.addEventListener('click', e => { const b = e.target.closest('button[data-p]'); if (b) go(b.dataset.p); });
window.addEventListener('message', e => {
  if (e.data && e.data.nav) {
    const target = String(e.data.nav).split('/').pop();
    go(target);
  }
});
go(location.hash ? location.hash.slice(1) : 'index.html');
</script>
</body>
</html>
`;

const out = join(root, "docs", "system1-viewer.html");
await writeFile(out, shell);
console.log(`wrote ${out} (${(shell.length / 1024).toFixed(0)} KiB, ${PAGES.length} pages)`);
