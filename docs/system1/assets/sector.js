/* Shared site machinery for the System 1 design pages.
   One nav definition -> every page carries the identical structure.
   One demo sequencer -> every sector page runs its demo the same way:
   caption + progress dots + steps + replay. */
const SECTORS = [
  { n: "01", slug: "sectioning", label: "Sectioning" },
  { n: "02", slug: "scene-boundary", label: "Scene boundary" },
  { n: "03", slug: "dialogue-detector", label: "Dialogue" },
  { n: "04", slug: "name-detector", label: "Names" },
  { n: "05", slug: "presence-detector", label: "Presence" },
  { n: "06", slug: "speaker-attribution", label: "Speakers" },
  { n: "07", slug: "miniloop-engine", label: "Miniloop engine" },
  { n: "08", slug: "extraction", label: "Extraction" },
  { n: "09", slug: "merge-gate", label: "Merge gate" },
  { n: "10", slug: "storage-connectors", label: "Storage" },
  { n: "11", slug: "timeline-forking", label: "Timelines & forks" },
  { n: "12", slug: "simulation", label: "Simulation" },
  { n: "13", slug: "playground-frontend", label: "Playground frontend" },
];

function renderNav() {
  const here = location.pathname.split("/").pop() || "index.html";
  const nav = document.getElementById("sitenav");
  if (!nav) return;
  const links = [
    `<a class="page ${here === "index.html" ? "here" : ""}" href="index.html">Overview</a>`,
    `<a class="page ${here === "roadmap.html" ? "here" : ""}" href="roadmap.html">🗺 Roadmap</a>`,
    ...SECTORS.map(
      (s) =>
        `<a class="page ${here === s.slug + ".html" ? "here" : ""}" href="${s.slug}.html">${s.n} ${s.label}</a>`,
    ),
  ].join("");
  nav.innerHTML = `<a class="brand" href="index.html">novel-ontology-pi<small>System 1 · design by sector</small></a><div class="links">${links}</div>`;
}

function renderPager() {
  const here = location.pathname.split("/").pop() || "index.html";
  const el = document.getElementById("pager");
  if (!el) return;
  const order = ["index.html", "roadmap.html", ...SECTORS.map((s) => s.slug + ".html")];
  const names = {
    "index.html": "Overview",
    "roadmap.html": "Roadmap",
    ...Object.fromEntries(SECTORS.map((s) => [s.slug + ".html", `${s.n} ${s.label}`])),
  };
  const i = order.indexOf(here);
  const prev = i > 0 ? order[i - 1] : null;
  const next = i >= 0 && i < order.length - 1 ? order[i + 1] : null;
  el.innerHTML =
    (prev ? `<a href="${prev}">← ${names[prev]}</a>` : "<span></span>") +
    (next ? `<a href="${next}">Next: ${names[next]} →</a>` : "<span></span>");
}

/* The demo sequencer — identical on every sector page.
   steps: [{ t: ms, cap: [title, why], run: fn, reset?: fn }] */
function runSectorDemo(steps) {
  const caption = document.getElementById("caption");
  const dots = document.getElementById("dots");
  const replay = document.getElementById("replay");
  if (!caption || !dots) return;
  dots.innerHTML = steps.map(() => "<i></i>").join("");
  let idx = 0, timer = null;
  const play = () => {
    clearTimeout(timer);
    steps.forEach((s) => s.reset && s.reset());
    [...dots.children].forEach((d) => d.classList.remove("done"));
    idx = 0;
    const next = () => {
      if (idx >= steps.length) { timer = setTimeout(play, 4500); return; }
      const st = steps[idx];
      caption.innerHTML = `<span class="stepno">${idx + 1} / ${steps.length}</span>${st.cap[0]}<span class="why">${st.cap[1]}</span>`;
      st.run();
      dots.children[idx].classList.add("done");
      idx++;
      timer = setTimeout(next, st.t);
    };
    next();
  };
  if (replay) replay.onclick = play;
  play();
}

document.addEventListener("DOMContentLoaded", () => { renderNav(); renderPager(); });
