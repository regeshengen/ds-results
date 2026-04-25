from __future__ import annotations

import json
import re
from pathlib import Path

import pandas as pd
import plotly.graph_objects as go
import streamlit as st


DURATION_RE = re.compile(r"(avg|med|max|min|p\(90\)|p\(95\))=([0-9.]+)(us|ms|s)")
SUPPORTED_EXTENSIONS = (".log", ".txt", ".json")
DURATION_METRIC_KEYS = [
    "duration_avg_ms",
    "duration_min_ms",
    "duration_med_ms",
    "duration_max_ms",
    "duration_p90_ms",
    "duration_p95_ms",
]
DURATION_METRIC_LABELS = {
    "duration_avg_ms": "avg",
    "duration_min_ms": "min",
    "duration_med_ms": "med",
    "duration_max_ms": "max",
    "duration_p90_ms": "p(90)",
    "duration_p95_ms": "p(95)",
}
PERFORMANCE_COL = "rendimento_with_vs_without_%"


def to_ms(value: float, unit: str) -> float:
    if unit == "us":
        return value / 1000.0
    if unit == "ms":
        return value
    if unit == "s":
        return value * 1000.0
    return value


def to_mb(value: float, unit: str) -> float:
    scale = {
        "B": 1 / (1024 * 1024),
        "kB": 1 / 1024,
        "MB": 1,
        "GB": 1024,
        "TB": 1024 * 1024,
    }
    return value * scale.get(unit, 1)


def parse_line_rate(text: str, metric_name: str) -> tuple[float, float] | tuple[None, None]:
    pattern = rf"^{re.escape(metric_name)}\.*:\s*([0-9]+)\s+([0-9.]+)/s"
    match = re.search(pattern, text, flags=re.MULTILINE)
    if not match:
        return None, None
    return float(match.group(1)), float(match.group(2))


def parse_duration_stats(text: str, metric_name: str) -> dict[str, float]:
    pattern = rf"^{re.escape(metric_name)}\.*:\s*(.+)$"
    line_match = re.search(pattern, text, flags=re.MULTILINE)
    if not line_match:
        return {}

    stats_text = line_match.group(1)
    stats: dict[str, float] = {}
    for key, value, unit in DURATION_RE.findall(stats_text):
        normalized_key = key.replace("(", "").replace(")", "")
        stats[normalized_key] = to_ms(float(value), unit)
    return stats


def parse_percentage_metric(text: str, metric_name: str) -> float | None:
    pattern = rf"^{re.escape(metric_name)}\.*:\s*([0-9.]+)%"
    match = re.search(pattern, text, flags=re.MULTILINE)
    if not match:
        return None
    return float(match.group(1))


def parse_vus_max(text: str) -> float | None:
    pattern = r"^vus_max\.*:\s*([0-9]+)\s+min=([0-9]+)\s+max=([0-9]+)"
    match = re.search(pattern, text, flags=re.MULTILINE)
    if not match:
        return None
    return float(match.group(3))


def parse_data_sent_rate_mb_s(text: str) -> float | None:
    pattern = r"^data_sent\.*:\s*[0-9.]+\s*(B|kB|MB|GB|TB)\s+([0-9.]+)\s*(kB/s|MB/s|GB/s|B/s|TB/s)"
    match = re.search(pattern, text, flags=re.MULTILINE)
    if not match:
        return None

    rate_value = float(match.group(2))
    rate_unit = match.group(3).replace("/s", "")
    return to_mb(rate_value, rate_unit)


def parse_k6_summary(text: str) -> dict[str, float | None]:
    req_duration = parse_duration_stats(text, "http_req_duration")

    return {
        "duration_avg_ms": req_duration.get("avg"),
        "duration_min_ms": req_duration.get("min"),
        "duration_med_ms": req_duration.get("med"),
        "duration_max_ms": req_duration.get("max"),
        "duration_p90_ms": req_duration.get("p90"),
        "duration_p95_ms": req_duration.get("p95"),
    }


def summarize_from_json_points(points_by_metric: dict[str, list[tuple[float, float]]]) -> dict[str, float | None]:
    duration_points = [v for _, v in points_by_metric.get("http_req_duration", [])]
    duration_s = pd.Series(duration_points, dtype="float64")

    return {
        "duration_avg_ms": float(duration_s.mean()) if not duration_s.empty else None,
        "duration_min_ms": float(duration_s.min()) if not duration_s.empty else None,
        "duration_med_ms": float(duration_s.median()) if not duration_s.empty else None,
        "duration_max_ms": float(duration_s.max()) if not duration_s.empty else None,
        "duration_p90_ms": float(duration_s.quantile(0.90)) if not duration_s.empty else None,
        "duration_p95_ms": float(duration_s.quantile(0.95)) if not duration_s.empty else None,
    }


def parse_k6_json(path: Path) -> tuple[dict[str, float | None], pd.DataFrame]:
    points_by_metric: dict[str, list[tuple[float, float]]] = {}
    first_time: pd.Timestamp | None = None

    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue

        if item.get("type") != "Point":
            continue

        metric = item.get("metric")
        data = item.get("data", {})
        value = data.get("value")
        timestamp = data.get("time")

        if metric is None or value is None or timestamp is None:
            continue

        ts = pd.to_datetime(timestamp, utc=True, errors="coerce")
        if pd.isna(ts):
            continue

        if first_time is None:
            first_time = ts

        elapsed_s = (ts - first_time).total_seconds()
        points_by_metric.setdefault(metric, []).append((float(elapsed_s), float(value)))

    summary = summarize_from_json_points(points_by_metric)
    return summary, pd.DataFrame()


def get_file_cache_token(path: Path) -> tuple[int, int]:
    stat = path.stat()
    return stat.st_mtime_ns, stat.st_size


@st.cache_data
def load_any_file(path: Path, cache_token: tuple[int, int]) -> tuple[dict[str, float | None], pd.DataFrame, str]:
    _ = cache_token
    suffix = path.suffix.lower()
    if suffix == ".json":
        summary, ts_df = parse_k6_json(path)
        return summary, ts_df, "json"

    raw_text = path.read_text(encoding="utf-8")
    summary = parse_k6_summary(raw_text)
    return summary, pd.DataFrame(), "text"


def _is_with_router(name: str) -> bool:
    lowered = name.lower()
    return "with-router" in lowered or "com-router" in lowered


def _is_without_router(name: str) -> bool:
    lowered = name.lower()
    return "without-router" in lowered or "sem-router" in lowered


def _resolve_with_without(
    file_a: str,
    file_b: str,
    data_a: dict,
    data_b: dict,
) -> tuple[str, str, dict, dict]:
    if _is_with_router(file_a) and _is_without_router(file_b):
        return file_a, file_b, data_a, data_b
    if _is_with_router(file_b) and _is_without_router(file_a):
        return file_b, file_a, data_b, data_a
    # Fallback: assume A as with-router and B as without-router when names do not match.
    return file_a, file_b, data_a, data_b


def _performance_pct(metric: str, with_val: float | None, without_val: float | None) -> float | None:
    if with_val is None or without_val is None or without_val == 0:
        return None

    lower_is_better = {
        "duration_avg_ms",
        "duration_min_ms",
        "duration_med_ms",
        "duration_max_ms",
        "duration_p90_ms",
        "duration_p95_ms",
    }

    if metric in lower_is_better:
        return ((without_val - with_val) / without_val) * 100.0
    return ((with_val - without_val) / without_val) * 100.0


def format_comparison_table(file_a: str, file_b: str, data_a: dict, data_b: dict) -> pd.DataFrame:
    with_file, without_file, with_data, without_data = _resolve_with_without(file_a, file_b, data_a, data_b)
    rows = []
    for key in DURATION_METRIC_KEYS:
        rows.append(
            {
                "metric": DURATION_METRIC_LABELS.get(key, key),
                file_a: data_a.get(key),
                file_b: data_b.get(key),
                PERFORMANCE_COL: _performance_pct(
                    key,
                    with_data.get(key),
                    without_data.get(key),
                ),
            }
        )
    df = pd.DataFrame(rows)
    if PERFORMANCE_COL in df.columns:
        df[PERFORMANCE_COL] = df[PERFORMANCE_COL].round(2)

    st.caption(f"Rendimento calculado como comparação de `{with_file}` vs `{without_file}`.")
    return df


def format_performance_badge(value: float | None) -> str:
    if value is None or pd.isna(value):
        return "N/A"
    if value > 0:
        return f"▲ +{value:.2f}%"
    if value < 0:
        return f"▼ {value:.2f}%"
    return "■ 0.00%"


def style_performance_badge(value: str) -> str:
    if isinstance(value, str) and value.startswith("▲"):
        return "background-color: #16a34a; color: #ffffff; font-weight: 700; border-radius: 999px;"
    if isinstance(value, str) and value.startswith("▼"):
        return "background-color: #dc2626; color: #ffffff; font-weight: 700; border-radius: 999px;"
    if isinstance(value, str) and value.startswith("■"):
        return "background-color: #4b5563; color: #ffffff; font-weight: 700; border-radius: 999px;"
    return ""


def average_summaries(summaries: list[dict[str, float | None]]) -> dict[str, float | None]:
    averaged: dict[str, float | None] = {}
    for key in DURATION_METRIC_KEYS:
        values = [s.get(key) for s in summaries if s.get(key) is not None]
        averaged[key] = float(sum(values) / len(values)) if values else None
    return averaged


def build_styled_comparison_figure(
    label_a: str,
    label_b: str,
    data_a: dict[str, float | None],
    data_b: dict[str, float | None],
):
    categories = ["avg", "med", "p(90)", "p(95)"]
    keys = ["duration_avg_ms", "duration_med_ms", "duration_p90_ms", "duration_p95_ms"]

    values_a = [data_a.get(k) or 0 for k in keys]
    values_b = [data_b.get(k) or 0 for k in keys]

    bg_color = "#ffffff"
    text_color = "#1f2937"

    fig = go.Figure()
    fig.add_bar(name=label_a, x=categories, y=values_a, marker_color="#1f77b4")
    fig.add_bar(name=label_b, x=categories, y=values_b, marker_color="#ff7f0e")

    fig.update_layout(
        barmode="group",
        title=None,
        yaxis_title="Duration (ms)",
        plot_bgcolor=bg_color,
        paper_bgcolor=bg_color,
        font=dict(color=text_color),
        legend=dict(
            x=0.01,
            y=0.99,
            xanchor="left",
            yanchor="top",
            bgcolor="rgba(255,255,255,0.75)",
            font=dict(color=text_color),
        ),
        margin=dict(l=20, r=20, t=60, b=40),
    )
    fig.update_xaxes(tickangle=20, tickfont=dict(color=text_color), title_font=dict(color=text_color))
    fig.update_yaxes(tickfont=dict(color=text_color), title_font=dict(color=text_color), gridcolor="rgba(0,0,0,0.18)")
    fig.update_layout(margin=dict(l=20, r=20, t=20, b=40))
    return fig


def render_metrics_and_chart(file_a: str, file_b: str, data_a: dict, data_b: dict, label_a: str, label_b: str) -> None:
    table_df = format_comparison_table(file_a, file_b, data_a, data_b)

    st.subheader("Metrics table")
    display_df = table_df.copy()
    display_df[PERFORMANCE_COL] = display_df[PERFORMANCE_COL].apply(format_performance_badge)
    styled_df = display_df.style.applymap(style_performance_badge, subset=[PERFORMANCE_COL])
    st.dataframe(styled_df, use_container_width=True)

    st.subheader("Comparison chart")
    fig = build_styled_comparison_figure(label_a, label_b, data_a, data_b)
    st.plotly_chart(fig, use_container_width=True)


def main() -> None:
    st.set_page_config(page_title="k6 Log Compare", layout="wide")
    st.markdown(
        """
        <style>
        div[data-testid="stPlotlyChart"] {
            background: #ffffff;
            border: 1px solid #e5e7eb;
            border-radius: 18px;
            overflow: hidden;
            padding: 8px;
        }
        div[data-testid="stExpander"] {
            border: none;
            border-bottom: 1px solid #d1d5db;
            border-radius: 0;
            margin-bottom: 6px;
            background: transparent;
        }
        div[data-testid="stExpander"] details {
            border: none;
            background: transparent;
        }
        div[data-testid="stExpander"] summary {
            font-size: 1.15rem;
            font-weight: 500;
            padding: 0.9rem 0.4rem;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )
    st.markdown(
        "<h1 style='font-size:3.4rem;text-align:center;margin-bottom:0.2rem'>k6 Log Comparison Dashboard</h1>",
        unsafe_allow_html=True,
    )
    st.markdown("---")
    st.caption("Compare text summary logs and JSON outputs from k6.")

    base_dir = Path(__file__).parent
    log_dir = base_dir / "logs"

    files_with = sorted([
        p.name for p in log_dir.iterdir()
        if p.is_file() and p.suffix.lower() == ".json" and "with-router" in p.name.lower()
    ])
    files_without = sorted([
        p.name for p in log_dir.iterdir()
        if p.is_file() and p.suffix.lower() == ".json" and "without-router" in p.name.lower()
    ])

    if not files_with:
        st.error("Nenhum arquivo .json com 'with-router' no nome encontrado em results/logs.")
        return
    if not files_without:
        st.error("Nenhum arquivo .json com 'without-router' no nome encontrado em results/logs.")
        return

    col_left, col_right = st.columns(2)
    with col_left:
        file_a_options = ["Select..."] + files_with
        file_a = st.selectbox("Log file A (with-router)", file_a_options, index=0)
    with col_right:
        file_b_options = ["Select..."] + files_without
        file_b = st.selectbox("Log file B (without-router)", file_b_options, index=0)

    if file_a != "Select..." and file_b != "Select...":
        path_a = log_dir / file_a
        path_b = log_dir / file_b
        data_a, _, _ = load_any_file(path_a, get_file_cache_token(path_a))
        data_b, _, _ = load_any_file(path_b, get_file_cache_token(path_b))

        col_label_a, col_label_b = st.columns(2)
        with col_label_a:
            label_a = st.text_input("Label A", value="With Middleware")
        with col_label_b:
            label_b = st.text_input("Label B", value="Without Middleware")

        render_metrics_and_chart(file_a, file_b, data_a, data_b, label_a, label_b)
    else:
        st.info("Selecione os arquivos nos dois dropdowns para exibir a comparação customizada.")

    st.markdown("---")
    st.markdown(
        "<h1 style='font-size:3.2rem;margin-bottom:0.2rem;text-align:center'>Results</h1>",
        unsafe_allow_html=True,
    )
    st.markdown(
        "<p style='margin-top:0;margin-bottom:0.4rem;text-align:center;color:#6b7280;font-size:0.95rem'>"
        "All AWS Tests with 3 minuts running 20 requests per second"
        "</p>",
        unsafe_allow_html=True,
    )
    st.markdown("---")

    with_ids = {
        int(m.group(1))
        for name in files_with
        for m in [re.match(r"^(\d+)-with-router\.json$", name, flags=re.IGNORECASE)]
        if m
    }
    without_ids = {
        int(m.group(1))
        for name in files_without
        for m in [re.match(r"^(\d+)-without-router\.json$", name, flags=re.IGNORECASE)]
        if m
    }
    test_ids = sorted(with_ids & without_ids)

    if not test_ids:
        st.warning("Nenhum par de testes com padrão NNN-with-router.json / NNN-without-router.json foi encontrado.")
        return

    avg_with_summaries: list[dict[str, float | None]] = []
    avg_without_summaries: list[dict[str, float | None]] = []

    for test_id in test_ids:
        with_file = f"{test_id:03d}-with-router.json"
        without_file = f"{test_id:03d}-without-router.json"

        with st.expander(f"Teste {test_id}", expanded=False):
            st.caption(f"{with_file} vs {without_file}")

            if with_file not in files_with or without_file not in files_without:
                st.warning(f"Arquivos do Teste {test_id} não encontrados em results/logs.")
                continue

            with_path = log_dir / with_file
            without_path = log_dir / without_file
            test_data_a, _, _ = load_any_file(with_path, get_file_cache_token(with_path))
            test_data_b, _, _ = load_any_file(without_path, get_file_cache_token(without_path))

            avg_with_summaries.append(test_data_a)
            avg_without_summaries.append(test_data_b)

            render_metrics_and_chart(
                with_file,
                without_file,
                test_data_a,
                test_data_b,
                "With Middleware",
                "Without Middleware",
            )

    if avg_with_summaries and avg_without_summaries:
        average_with_data = average_summaries(avg_with_summaries)
        average_without_data = average_summaries(avg_without_summaries)

        with st.expander("Average Of The All Tests", expanded=False):
            st.caption(f"Média de {len(avg_with_summaries)} testes")
            render_metrics_and_chart(
                "average-with-router.json",
                "average-without-router.json",
                average_with_data,
                average_without_data,
                "With Middleware (Average)",
                "Without Middleware (Average)",
            )

if __name__ == "__main__":
    main()
