// js/app.js — main dashboard logic (mirrors app.py structure)

import { parseK6Json, averageSummaries, DURATION_METRIC_KEYS, DURATION_METRIC_LABELS } from "./parser.js";

const LOG_ROOT_DIR = "logs";
const AWS_25_180_LOG_DIR = `${LOG_ROOT_DIR}/aws/25req180`;
const AWS_25_360_LOG_DIR = `${LOG_ROOT_DIR}/aws/25req360`;
const AWS_25_540_LOG_DIR = `${LOG_ROOT_DIR}/aws/25req540`;
const AWS_50_180_LOG_DIR = `${LOG_ROOT_DIR}/aws/50req180`;
const AWS_50_360_LOG_DIR = `${LOG_ROOT_DIR}/aws/50req360`;
const AWS_50_540_LOG_DIR = `${LOG_ROOT_DIR}/aws/50req540`;
const DEFAULT_TEST_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const THEME_STORAGE_KEY = "dashboard-theme";
const POLL_INTERVAL_MS = 10_000;

function getThemeColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    plotBg: styles.getPropertyValue("--plot-bg").trim(),
    paperBg: styles.getPropertyValue("--chart-bg").trim(),
    plotText: styles.getPropertyValue("--plot-text").trim(),
    text: styles.getPropertyValue("--text").trim(),
    grid: styles.getPropertyValue("--grid").trim(),
    legendBg: styles.getPropertyValue("--legend-bg").trim(),
    seriesA: styles.getPropertyValue("--series-a").trim(),
    seriesB: styles.getPropertyValue("--series-b").trim(),
  };
}

function refreshAllPlotThemes() {
  const colors = getThemeColors();
  document.querySelectorAll(".js-plotly-plot").forEach((plotEl) => {
    Plotly.relayout(plotEl, {
      plot_bgcolor: colors.plotBg,
      paper_bgcolor: colors.paperBg,
      "font.color": colors.plotText,
      "legend.bgcolor": colors.legendBg,
      "legend.font.color": colors.plotText,
      "xaxis.tickfont.color": colors.plotText,
      "yaxis.tickfont.color": colors.plotText,
      "yaxis.title.font.color": colors.plotText,
      "yaxis.gridcolor": colors.grid,
    });
    Plotly.restyle(plotEl, [{ "marker.color": colors.seriesA }, { "marker.color": colors.seriesB }], [0, 1]);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_STORAGE_KEY, theme);

  const themeToggle = document.getElementById("theme-toggle");
  if (themeToggle) themeToggle.checked = theme === "light";

  refreshAllPlotThemes();
}

function setupThemeToggle() {
  const themeToggle = document.getElementById("theme-toggle");
  if (!themeToggle) return;

  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  const initialTheme = savedTheme === "light" ? "light" : "dark";
  applyTheme(initialTheme);

  themeToggle.addEventListener("change", () => {
    applyTheme(themeToggle.checked ? "light" : "dark");
  });
}

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
  const colors = getThemeColors();

  const chartDiv = el("div", { className: "chart-container" });
  container.appendChild(chartDiv);

  Plotly.newPlot(
    chartDiv,
    [
      { type: "bar", name: labelA, x: cats, y: keys.map(k => dataA[k] ?? 0), marker: { color: colors.seriesA } },
      { type: "bar", name: labelB, x: cats, y: keys.map(k => dataB[k] ?? 0), marker: { color: colors.seriesB } },
    ],
    {
      barmode: "group",
      yaxis: {
        title: "Duration (ms)",
        gridcolor: colors.grid,
        tickfont: { color: colors.plotText },
        titlefont: { color: colors.plotText },
      },
      xaxis: { tickfont: { color: colors.plotText } },
      plot_bgcolor: colors.plotBg,
      paper_bgcolor: colors.paperBg,
      font: { color: colors.plotText },
      legend: {
        x: 0.01,
        y: 0.99,
        xanchor: "left",
        yanchor: "top",
        bgcolor: colors.legendBg,
        font: { color: colors.plotText },
      },
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

// ── AWS scenario tabs ───────────────────────────────────────────────────────

async function buildAwsScenarioTab(container, testIds, logDir) {
  if (!testIds.length) {
    container.appendChild(createInfoMsg(
      "No test pair matching the NNN-with-router.json / NNN-without-router.json pattern was found."
    ));
    return null;
  }

  // Fetch all test data in parallel
  const settled = await Promise.allSettled(
    testIds.map(async id => {
      const p = String(id).padStart(3, "0");
      const [dataA, dataB] = await Promise.all([
        fetchAndParse(`${logDir}/${p}-with-router.json`),
        fetchAndParse(`${logDir}/${p}-without-router.json`),
      ]);
      return { id, dataA, dataB };
    })
  );

  const loaded = [];
  let maxLoadedId = 0;

  settled.forEach((result, idx) => {
    const id = testIds[idx];

    if (result.status === "fulfilled") {
      const { dataA, dataB } = result.value;
      const p   = String(id).padStart(3, "0");
      const wf  = `${p}-with-router.json`;
      const wof = `${p}-without-router.json`;
      loaded.push({ dataA, dataB });
      if (id > maxLoadedId) maxLoadedId = id;

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

  // ── Live average expander — re-renders whenever new tests arrive ───────────
  const avgDetails = el("details", { className: "expander" });
  avgDetails.appendChild(el("summary", { textContent: "Average Of The All Tests" }));
  const avgCaption = el("p", { className: "expander-caption" });
  const avgContent = el("div", { className: "expander-content" });
  avgDetails.appendChild(avgCaption);
  avgDetails.appendChild(avgContent);

  function renderAvg() {
    if (!loaded.length) return;
    avgCaption.textContent = `Average of ${loaded.length} tests`;
    avgContent.innerHTML = "";
    const avgWith    = averageSummaries(loaded.map(t => t.dataA));
    const avgWithout = averageSummaries(loaded.map(t => t.dataB));
    renderMetricsAndChart(
      avgContent,
      "average-with-router.json", "average-without-router.json",
      avgWith, avgWithout,
      "With Middleware (Average)", "Without Middleware (Average)"
    );
  }

  avgDetails.addEventListener("toggle", () => {
    if (avgDetails.open) {
      renderAvg();
      avgContent.querySelectorAll(".js-plotly-plot").forEach(e => Plotly.Plots.resize(e));
    }
  });

  if (loaded.length) {
    avgCaption.textContent = `Average of ${loaded.length} tests`;
    container.appendChild(avgDetails);
  }

  return { loaded, maxLoadedId, container, logDir, avgDetails, avgCaption, renderAvg };
}

// ── Auto-poll for new test files ─────────────────────────────────────────────

async function pollScenario(state) {
  if (!state) return;
  const nextId = state.maxLoadedId + 1;
  const p = String(nextId).padStart(3, "0");

  try {
    const [dataA, dataB] = await Promise.all([
      fetchAndParse(`${state.logDir}/${p}-with-router.json`),
      fetchAndParse(`${state.logDir}/${p}-without-router.json`),
    ]);

    const wf  = `${p}-with-router.json`;
    const wof = `${p}-without-router.json`;
    state.loaded.push({ dataA, dataB });
    state.maxLoadedId = nextId;

    const expander = createExpander(`Test ${nextId}`, `${wf} vs ${wof}`, content => {
      renderMetricsAndChart(content, wf, wof, dataA, dataB, "With Middleware", "Without Middleware");
    });

    // Insert before average expander, or append + add average if first test ever
    if (state.avgDetails.parentNode === state.container) {
      state.container.insertBefore(expander, state.avgDetails);
    } else {
      state.container.appendChild(expander);
      state.avgCaption.textContent = `Average of ${state.loaded.length} tests`;
      state.container.appendChild(state.avgDetails);
    }

    // Refresh average if currently open, otherwise just update caption
    if (state.avgDetails.open) state.renderAvg();
    else state.avgCaption.textContent = `Average of ${state.loaded.length} tests`;

  } catch { /* file not yet available — retry on next interval */ }

  setTimeout(() => pollScenario(state), POLL_INTERVAL_MS);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function init() {
  setupThemeToggle();
  const mainContent = document.getElementById("main-content");

  // Load manifest to discover test IDs
  let manifest = {};
  try {
    const resp = await fetch(`${LOG_ROOT_DIR}/manifest.json`);
    if (resp.ok) manifest = await resp.json();
  } catch { /* fall back to empty manifest */ }

  const aws25x180Ids = (manifest.aws_25_180 ?? DEFAULT_TEST_IDS).map(Number);
  const aws25x360Ids = (manifest.aws_25_360 ?? DEFAULT_TEST_IDS).map(Number);
  const aws25x540Ids = (manifest.aws_25_540 ?? DEFAULT_TEST_IDS).map(Number);
  const aws50x180Ids = (manifest.aws_50_180 ?? DEFAULT_TEST_IDS).map(Number);
  const aws50x360Ids = (manifest.aws_50_360 ?? DEFAULT_TEST_IDS).map(Number);
  const aws50x540Ids = (manifest.aws_50_540 ?? DEFAULT_TEST_IDS).map(Number);

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
    { label: "10 x 25 users x 360 sec" },
    { label: "10 x 25 users x 540 sec" },
    { label: "10 x 50 users x 180 sec" },
    { label: "10 x 50 users x 360 sec" },
    { label: "10 x 50 users x 540 sec" },
  ]);
  panels[0].appendChild(awsWrapper);

  const scenarioStates = [];
  scenarioStates.push(await buildAwsScenarioTab(awsPanels[0], aws25x180Ids, AWS_25_180_LOG_DIR));
  scenarioStates.push(await buildAwsScenarioTab(awsPanels[1], aws25x360Ids, AWS_25_360_LOG_DIR));
  scenarioStates.push(await buildAwsScenarioTab(awsPanels[2], aws25x540Ids, AWS_25_540_LOG_DIR));
  scenarioStates.push(await buildAwsScenarioTab(awsPanels[3], aws50x180Ids, AWS_50_180_LOG_DIR));
  scenarioStates.push(await buildAwsScenarioTab(awsPanels[4], aws50x360Ids, AWS_50_360_LOG_DIR));
  scenarioStates.push(await buildAwsScenarioTab(awsPanels[5], aws50x540Ids, AWS_50_540_LOG_DIR));

  // Start polling each scenario for new files
  scenarioStates.forEach(state => setTimeout(() => pollScenario(state), POLL_INTERVAL_MS));

  panels[1].appendChild(createInfoMsg("No results configured for Azure at the moment."));
  panels[2].appendChild(createInfoMsg("No results configured for On Premises at the moment."));
}

init().catch(err => {
  document.getElementById("main-content").innerHTML =
    `<p class="error">Failed to initialize dashboard: ${err.message}</p>`;
});
