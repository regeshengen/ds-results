// js/app.js — main dashboard logic (mirrors app.py structure)

import { parseK6Json, averageSummaries, DURATION_METRIC_KEYS, DURATION_METRIC_LABELS } from "./parser.js";

const LOG_DIR = "logs";

// ── Data loading ────────────────────────────────────────────────────────────

async function fetchAndParse(path) {
  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${path}`);
  return parseK6Json(await resp.text());
}

// ── Performance helpers ──────────────────────────────────────────────────────

function isWithRouter(name) {
  const l = name.toLowerCase();
  // "without-router" and "sem-router" must not match as with-router
  return (l.includes("with-router") || l.includes("com-router")) &&
         !l.includes("without") && !l.includes("sem-");
}

function performancePct(withVal, withoutVal) {
  if (withVal == null || withoutVal == null || withoutVal === 0) return null;
  // All duration metrics are lower-is-better:
  // positive result → with-router is faster than without-router
  return ((withoutVal - withVal) / withoutVal) * 100;
}

function badgeFor(value) {
  if (value == null || Number.isNaN(value)) return { text: "N/A",              cls: "badge-neutral" };
  if (value > 0)                            return { text: `▲ +${value.toFixed(2)}%`, cls: "badge-green"   };
  if (value < 0)                            return { text: `▼ ${value.toFixed(2)}%`,  cls: "badge-red"     };
  return                                           { text: "■ 0.00%",           cls: "badge-gray"    };
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, props = {}) {
  return Object.assign(document.createElement(tag), props);
}

function createInfoMsg(text, cls = "info") {
  return el("p", { className: cls, textContent: text });
}

// ── Table rendering ──────────────────────────────────────────────────────────

function renderTable(container, fileA, fileB, dataA, dataB) {
  // Resolve which side is "with" and which is "without"
  let withFile = fileA, withoutFile = fileB, withData = dataA, withoutData = dataB;
  if (!isWithRouter(fileA) && isWithRouter(fileB)) {
    [withFile, withoutFile, withData, withoutData] = [fileB, fileA, dataB, dataA];
  }

  container.appendChild(
    el("p", { className: "table-caption",
              textContent: `Performance calculated as comparison of ${withFile} vs ${withoutFile}.` })
  );

  const table = el("table", { className: "metrics-table" });

  // Header
  const hRow = table.createTHead().insertRow();
  [DURATION_METRIC_LABELS["duration_avg_ms"] ? "Metric" : "Metric", fileA, fileB, "Performance"]
    .forEach(h => hRow.appendChild(el("th", { textContent: h })));

  // Rows
  const tbody = table.createTBody();
  for (const key of DURATION_METRIC_KEYS) {
    const pct = performancePct(withData[key], withoutData[key]);
    const { text: badgeText, cls: badgeCls } = badgeFor(pct);
    const row = tbody.insertRow();

    [
      DURATION_METRIC_LABELS[key],
      dataA[key] != null ? dataA[key].toFixed(2) : "—",
      dataB[key] != null ? dataB[key].toFixed(2) : "—",
    ].forEach(v => row.insertCell().textContent = v);

    row.insertCell().appendChild(
      el("span", { className: `badge ${badgeCls}`, textContent: badgeText })
    );
  }

  container.appendChild(table);
}

// ── Chart rendering ──────────────────────────────────────────────────────────

function renderChart(container, labelA, labelB, dataA, dataB) {
  const keys = ["duration_avg_ms", "duration_med_ms", "duration_p90_ms", "duration_p95_ms"];
  const cats = ["avg", "med", "p(90)", "p(95)"];

  const chartDiv = el("div", { className: "chart-container" });
  container.appendChild(chartDiv);

  Plotly.newPlot(
    chartDiv,
    [
      { type: "bar", name: labelA, x: cats, y: keys.map(k => dataA[k] ?? 0), marker: { color: "#1f77b4" } },
      { type: "bar", name: labelB, x: cats, y: keys.map(k => dataB[k] ?? 0), marker: { color: "#ff7f0e" } },
    ],
    {
      barmode: "group",
      yaxis: { title: "Duration (ms)", gridcolor: "rgba(0,0,0,0.18)" },
      plot_bgcolor: "#ffffff",
      paper_bgcolor: "#ffffff",
      font: { color: "#1f2937" },
      legend: { x: 0.01, y: 0.99, xanchor: "left", yanchor: "top", bgcolor: "rgba(255,255,255,0.75)" },
      margin: { l: 60, r: 20, t: 20, b: 40 },
    },
    { responsive: true, displayModeBar: false }
  );
}

function renderMetricsAndChart(container, fileA, fileB, dataA, dataB, labelA, labelB) {
  const tableSection = el("div", { className: "section" });
  tableSection.appendChild(el("h3", { textContent: "Metrics table" }));
  renderTable(tableSection, fileA, fileB, dataA, dataB);
  container.appendChild(tableSection);

  const chartSection = el("div", { className: "section" });
  chartSection.appendChild(el("h3", { textContent: "Comparison chart" }));
  renderChart(chartSection, labelA, labelB, dataA, dataB);
  container.appendChild(chartSection);
}

// ── Expander ─────────────────────────────────────────────────────────────────
// Charts are rendered lazily (on first open) so Plotly gets correct dimensions.

function createExpander(title, caption, onFirstOpen) {
  const details = el("details", { className: "expander" });
  details.appendChild(el("summary", { textContent: title }));

  if (caption) {
    details.appendChild(el("p", { className: "expander-caption", textContent: caption }));
  }

  const content = el("div", { className: "expander-content" });
  details.appendChild(content);

  let rendered = false;
  details.addEventListener("toggle", () => {
    if (details.open && !rendered) {
      rendered = true;
      onFirstOpen(content);
    }
    // Resize any already-rendered Plotly charts after re-opening
    if (details.open && rendered) {
      content.querySelectorAll(".js-plotly-plot").forEach(e => Plotly.Plots.resize(e));
    }
  });

  return details;
}

// ── Tab builder ──────────────────────────────────────────────────────────────

function createTabs(defs) {
  const wrapper = el("div", { className: "tabs-wrapper" });
  const bar = el("div", { className: "tab-bar" });
  wrapper.appendChild(bar);

  const panels = defs.map((def, i) => {
    const btn   = el("button", { className: "tab-btn" + (i === 0 ? " active" : ""), textContent: def.label });
    const panel = el("div",    { className: "tab-panel" + (i === 0 ? " active" : "") });

    btn.addEventListener("click", () => {
      bar.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      wrapper.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      panel.classList.add("active");
      // Resize Plotly charts that become visible
      panel.querySelectorAll(".js-plotly-plot").forEach(e => Plotly.Plots.resize(e));
    });

    bar.appendChild(btn);
    wrapper.appendChild(panel);
    return panel;
  });

  return { wrapper, panels };
}

// ── AWS / 25-users tab ───────────────────────────────────────────────────────

async function buildAws25Tab(container, testIds) {
  if (!testIds.length) {
    container.appendChild(createInfoMsg(
      "No test pair matching the NNN-with-router.json / NNN-without-router.json pattern was found."
    ));
    return;
  }

  // Fetch all test data in parallel
  const settled = await Promise.allSettled(
    testIds.map(async id => {
      const p = String(id).padStart(3, "0");
      const [dataA, dataB] = await Promise.all([
        fetchAndParse(`${LOG_DIR}/${p}-with-router.json`),
        fetchAndParse(`${LOG_DIR}/${p}-without-router.json`),
      ]);
      return { id, dataA, dataB };
    })
  );

  const loaded = [];

  settled.forEach((result, idx) => {
    const id = testIds[idx];

    if (result.status === "fulfilled") {
      const { dataA, dataB } = result.value;
      const p   = String(id).padStart(3, "0");
      const wf  = `${p}-with-router.json`;
      const wof = `${p}-without-router.json`;
      loaded.push({ dataA, dataB });

      container.appendChild(
        createExpander(`Test ${id}`, `${wf} vs ${wof}`, content => {
          renderMetricsAndChart(content, wf, wof, dataA, dataB, "With Middleware", "Without Middleware");
        })
      );
    } else {
      container.appendChild(
        createExpander(`Test ${id}`, null, content => {
          content.appendChild(createInfoMsg(`Could not load files for Test ${id}.`, "warn"));
        })
      );
    }
  });

  if (loaded.length) {
    const avgWith    = averageSummaries(loaded.map(t => t.dataA));
    const avgWithout = averageSummaries(loaded.map(t => t.dataB));

    container.appendChild(
      createExpander("Average Of The All Tests", `Average of ${loaded.length} tests`, content => {
        renderMetricsAndChart(
          content,
          "average-with-router.json", "average-without-router.json",
          avgWith, avgWithout,
          "With Middleware (Average)", "Without Middleware (Average)"
        );
      })
    );
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function init() {
  const mainContent = document.getElementById("main-content");

  // Load manifest to discover test IDs
  let manifest = {};
  try {
    const resp = await fetch(`${LOG_DIR}/manifest.json`);
    if (resp.ok) manifest = await resp.json();
  } catch { /* fall back to empty manifest */ }

  const awsIds = (manifest.aws_25 ?? []).map(Number);

  // Main tabs: AWS / Azure / On Premises
  const { wrapper, panels } = createTabs([
    { label: "AWS Results" },
    { label: "Azure Results" },
    { label: "On Premises Results" },
  ]);
  mainContent.appendChild(wrapper);

  // AWS sub-tabs
  const { wrapper: awsWrapper, panels: awsPanels } = createTabs([
    { label: "10 x 25 users x 180 sec" },
    { label: "10 x 50 users x 180 sec" },
    { label: "10 x 75 users x 180 sec" },
    { label: "10 x 75 users x 180 sec" },
  ]);
  panels[0].appendChild(awsWrapper);

  await buildAws25Tab(awsPanels[0], awsIds);
  awsPanels[1].appendChild(createInfoMsg("No results configured for this scenario at the moment."));
  awsPanels[2].appendChild(createInfoMsg("No results configured for this scenario at the moment."));
  awsPanels[3].appendChild(createInfoMsg("No results configured for this scenario at the moment."));

  panels[1].appendChild(createInfoMsg("No results configured for Azure at the moment."));
  panels[2].appendChild(createInfoMsg("No results configured for On Premises at the moment."));
}

init().catch(err => {
  document.getElementById("main-content").innerHTML =
    `<p class="error">Failed to initialize dashboard: ${err.message}</p>`;
});
