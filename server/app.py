from flask import Flask, request, send_file, jsonify
from flask_cors import CORS
import pandas as pd
import io
import re

app = Flask(__name__)

# Expose custom headers so the frontend can read them (important in production)
CORS(
    app,
    resources={r"/api/*": {"origins": "*"}},
    expose_headers=[
        "Content-Disposition",
        "X-Original-Rows",
        "X-Original-Cols",
        "X-Output-Rows",
        "X-Output-Cols",
        "X-Duplicates-Removed",
        "X-Empty-Cols-Removed",
        "X-Normalized-Date-Cols",
    ],
)

DATE_HINTS = (
    "date",
    "dob",
    "birthday",
    "created",
    "updated",
    "time",
    "timestamp",
    "ordered",
    "shipped",
)

def clean_headers(cols):
    cleaned = []
    for c in cols:
        c = str(c).strip().lower()
        c = re.sub(r"\s+", "_", c)
        c = re.sub(r"[^a-z0-9_]", "", c)
        c = re.sub(r"_+", "_", c).strip("_")
        cleaned.append(c or "col")

    # ensure unique
    seen = {}
    out = []
    for c in cleaned:
        n = seen.get(c, 0)
        out.append(f"{c}_{n}" if n else c)
        seen[c] = n + 1
    return out

def is_likely_date_col(name: str) -> bool:
    n = (name or "").lower()
    return any(h in n for h in DATE_HINTS)

def try_normalize_date_series(s: pd.Series):
    # Attempt parse; require enough successes to avoid wrecking random text columns
    parsed = pd.to_datetime(s, errors="coerce", infer_datetime_format=True, utc=False)
    success_ratio = float(parsed.notna().mean())
    if success_ratio >= 0.7:
        return parsed.dt.strftime("%Y-%m-%d")
    return None

@app.get("/api/health")
def health():
    return jsonify(ok=True)

@app.post("/api/clean-csv")
def clean_csv():
    if "file" not in request.files:
        return jsonify(error="Missing file"), 400

    f = request.files["file"]
    if not f.filename or not f.filename.lower().endswith(".csv"):
        return jsonify(error="Please upload a .csv file"), 400

    try:
        df = pd.read_csv(f)
    except Exception:
        return jsonify(error="Could not read CSV. Is it a valid CSV file?"), 400

    # --- stats: before ---
    original_rows = int(len(df))
    original_cols = int(df.shape[1])

    # clean headers
    df.columns = clean_headers(df.columns)

    # drop fully empty columns
    empty_cols_before = int(df.isna().all().sum())
    df = df.dropna(axis=1, how="all")

    # trim strings
    for col in df.select_dtypes(include=["object"]).columns:
        df[col] = df[col].astype(str).str.strip()

    # optional date normalization
    normalize_dates = request.form.get("normalize_dates", "false").lower() == "true"
    normalized_cols = []
    if normalize_dates:
        for col in df.columns:
            if df[col].dtype == "object" and is_likely_date_col(col):
                normalized = try_normalize_date_series(df[col])
                if normalized is not None:
                    df[col] = normalized
                    normalized_cols.append(col)

    # optional dedupe by selected columns
    before_dedupe_rows = int(len(df))
    dedupe_cols_raw = request.form.get("dedupe_cols", "").strip()

    if dedupe_cols_raw:
        dedupe_cols = [c.strip() for c in dedupe_cols_raw.split(",") if c.strip()]
        missing = [c for c in dedupe_cols if c not in df.columns]
        if missing:
            return jsonify(error=f"Unknown column(s): {', '.join(missing)}"), 400
        df = df.drop_duplicates(subset=dedupe_cols)
    else:
        df = df.drop_duplicates()

    after_rows = int(len(df))
    after_cols = int(df.shape[1])

    duplicates_removed = int(before_dedupe_rows - after_rows)
    empty_cols_removed = int(empty_cols_before)

    # write output CSV
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    mem = io.BytesIO(buf.getvalue().encode("utf-8"))
    mem.seek(0)

    out_name = f"cleaned_{f.filename}"
    resp = send_file(mem, mimetype="text/csv", as_attachment=True, download_name=out_name)

    # preview stats in headers
    resp.headers["X-Original-Rows"] = str(original_rows)
    resp.headers["X-Original-Cols"] = str(original_cols)
    resp.headers["X-Output-Rows"] = str(after_rows)
    resp.headers["X-Output-Cols"] = str(after_cols)
    resp.headers["X-Duplicates-Removed"] = str(duplicates_removed)
    resp.headers["X-Empty-Cols-Removed"] = str(empty_cols_removed)
    resp.headers["X-Normalized-Date-Cols"] = ",".join(normalized_cols)

    return resp

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
