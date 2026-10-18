from flask import Flask, request, send_file, jsonify
from flask_cors import CORS
import pandas as pd
import io
import re
import csv
from werkzeug.exceptions import RequestEntityTooLarge

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024

@app.errorhandler(RequestEntityTooLarge)
def too_large(error):
    return jsonify(error="File is too large. Maximum upload size is 20 MB."), 413

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

    # Reserve every generated name, including names already ending in a suffix.
    used = set()
    out = []
    for base in cleaned:
        name, suffix = base, 1
        while name in used:
            name = f"{base}_{suffix}"
            suffix += 1
        used.add(name)
        out.append(name)
    return out

def is_likely_date_col(name: str) -> bool:
    n = (name or "").lower()
    return any(h in n for h in DATE_HINTS)

def try_normalize_date_series(s: pd.Series):
    # Convert only explicit ISO dates; preserve ambiguous dates and timestamps.
    # Never replace an unparseable value with an empty cell.
    converted = s.copy()
    changed = False
    for index, value in s.items():
        if re.fullmatch(r"\d{4}[-/]\d{2}[-/]\d{2}", value):
            try:
                converted.at[index] = pd.Timestamp(value).strftime("%Y-%m-%d")
                changed = True
            except (ValueError, OverflowError):
                pass
    return converted if changed else None

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
        text = f.read().decode("utf-8-sig")
        raw_headers = next(csv.reader(io.StringIO(text)))
        # Read values as text so phone numbers, IDs and literal NA remain intact.
        df = pd.read_csv(io.StringIO(text), dtype=str, keep_default_na=False)
        if len(raw_headers) != len(df.columns):
            raise ValueError("Invalid header width")
        df.columns = raw_headers
    except Exception:
        return jsonify(error="Could not read CSV. Is it a valid CSV file?"), 400

    # --- stats: before ---
    original_rows = int(len(df))
    original_cols = int(df.shape[1])

    before_preview = {"columns": list(df.columns), "rows": df.head(10).values.tolist()}
    enabled = lambda key: request.form.get(key, "true").lower() == "true"

    # Use stable unique internal names for column selection even when labels are kept.
    df.columns = clean_headers(df.columns)

    # Trim before checking for empty columns; whitespace-only cells are empty.
    if enabled("trim_cells"):
        for col in df.columns:
            df[col] = df[col].str.strip()
    empty_cols = [col for col in df.columns if len(df) > 0 and df[col].str.strip().eq("").all()] if enabled("drop_empty_columns") else []
    empty_cols_before = len(empty_cols)
    df = df.drop(columns=empty_cols)

    # optional date normalization
    normalize_dates = request.form.get("normalize_dates", "false").lower() == "true"
    normalized_cols = []
    if normalize_dates:
        for col in df.columns:
            if is_likely_date_col(col):
                normalized = try_normalize_date_series(df[col])
                if normalized is not None:
                    df[col] = normalized
                    normalized_cols.append(col)

    # optional dedupe by selected columns
    before_dedupe_rows = int(len(df))
    dedupe_cols_raw = request.form.get("dedupe_cols", "").strip()

    if not enabled("remove_duplicates"):
        pass
    elif dedupe_cols_raw:
        dedupe_cols = [c.strip() for c in dedupe_cols_raw.split(",") if c.strip()]
        missing = [c for c in dedupe_cols if c not in df.columns and c not in empty_cols]
        dedupe_cols = [c for c in dedupe_cols if c in df.columns]
        if missing:
            return jsonify(error=f"Unknown column(s): {', '.join(missing)}"), 400
        df = df.drop_duplicates(subset=dedupe_cols) if dedupe_cols else df.drop_duplicates()
    else:
        df = df.drop_duplicates()

    after_rows = int(len(df))
    after_cols = int(df.shape[1])

    duplicates_removed = int(before_dedupe_rows - after_rows)
    empty_cols_removed = int(empty_cols_before)

    if not enabled("clean_headers"):
        labels = dict(zip(clean_headers(raw_headers), raw_headers))
        df.columns = [labels[col] for col in df.columns]

    # write output CSV
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    if request.form.get("preview", "false").lower() == "true":
        return jsonify(
            csv=buf.getvalue(), filename=f"cleaned_{f.filename}",
            before=before_preview,
            after={"columns": list(df.columns), "rows": df.head(10).values.tolist()},
            stats={"originalRows": original_rows, "originalCols": original_cols,
                   "outputRows": after_rows, "outputCols": after_cols,
                   "duplicatesRemoved": duplicates_removed, "emptyColsRemoved": empty_cols_removed,
                   "normalizedDateCols": normalized_cols},
        )
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
    app.run(host="0.0.0.0", port=5000, debug=False)
