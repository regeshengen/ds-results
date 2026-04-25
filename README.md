# k6 Comparison Dashboard

Simple Python dashboard to compare k6 summary logs and k6 JSON outputs.

## Run

```bash
cd run-tests-k6/results
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
streamlit run app.py
```

## Add new logs

Put new `.log` files into `results/logs/`.
The dashboard will list them automatically.

## Generate k6 JSON files (time series)

From `run-tests-k6/`, you can generate files like this:

```bash
k6 run --out json=results/logs/with-router.json test-with-router.js
k6 run --out json=results/logs/without-router.json test-without-router.js
```

When selecting two `.json` files in the dashboard, it will show:

- Summary comparison table
- Summary bar chart
- Time series line chart with metric selector and aggregation window
# dissertation-dashboard-results
