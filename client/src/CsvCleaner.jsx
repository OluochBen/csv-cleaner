import { useEffect, useMemo, useRef, useState } from "react";

function bytes(n) {
  if (!n && n !== 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function cleanHeader(h) {
  return (
    String(h ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "col"
  );
}

// Parse the first CSV record, including escaped quotes and quoted newlines.
async function readCsvHeaders(file) {
  const text = (await file.slice(0, 1024 * 1024).text()).replace(/^\uFEFF/, "");
  const raw = [];
  let value = "", quoted = false, ended = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (c === "," && !quoted) { raw.push(value); value = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) { ended = true; break; }
    else value += c;
  }
  if (quoted || (!ended && file.size > 1024 * 1024)) throw new Error("Could not read the CSV header.");
  raw.push(value);
  const used = new Set();
  return raw.map((r) => {
    const base = cleanHeader(r);
    let clean = base, suffix = 1;
    while (used.has(clean)) clean = `${base}_${suffix++}`;
    used.add(clean);
    return { raw: r || "Unnamed column", clean };
  });
}

export default function CsvCleaner() {
  // In production you can set VITE_API_URL to your backend URL.
  // For local dev, proxy handles it, so empty string works.
  const API = import.meta.env.VITE_API_URL || "";

  const [file, setFile] = useState(null);
  const [headers, setHeaders] = useState([]); // [{raw, clean}]
  const [selected, setSelected] = useState(new Set()); // cleaned names
  const [normalizeDates, setNormalizeDates] = useState(false);
  const inputRef = useRef(null);
  const pickVersion = useRef(0);
  const [dragging, setDragging] = useState(false);

  const [loading, setLoading] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadName, setDownloadName] = useState("");
  const [error, setError] = useState("");
  const [stats, setStats] = useState(null);

  useEffect(() => () => { if (downloadUrl) URL.revokeObjectURL(downloadUrl); }, [downloadUrl]);
  const selectedList = useMemo(() => Array.from(selected), [selected]);

  const pickFile = async (f) => {
    if (!f || loading) return;
    const version = ++pickVersion.current;
    setFile(null);
    setHeaders([]);
    setSelected(new Set());
    setError("");
    setDownloadUrl("");
    setStats(null);

    if (!f.size) return setError("This file is empty. Choose a CSV with data.");
    if (f.size > 20 * 1024 * 1024) return setError("Maximum file size is 20 MB.");

    if (!f.name.toLowerCase().endsWith(".csv")) {
      setError("Please upload a .csv file.");
      return;
    }

    setFile(f);
    setSelected(new Set());

    try {
      const h = await readCsvHeaders(f);
      if (version === pickVersion.current) setHeaders(h);
    } catch {
      if (version === pickVersion.current) setHeaders([]);
    }
  };

  const toggleCol = (clean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(clean)) next.delete(clean);
      else next.add(clean);
      return next;
    });
  };

  const clean = async () => {
    if (!file) return setError("Pick a CSV first.");

    setLoading(true);
    setError("");
    setDownloadUrl("");
    setStats(null);

    try {
      const form = new FormData();
      form.append("file", file);
      if (selectedList.length) form.append("dedupe_cols", selectedList.join(","));
      form.append("normalize_dates", String(normalizeDates));

      const res = await fetch(`${API}/api/clean-csv`, {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        let msg = "Failed to clean file.";
        try {
          const j = await res.json();
          msg = j.error || msg;
        } catch {}
        throw new Error(msg);
      }

      // read preview stats from headers
      const s = {
        originalRows: Number(res.headers.get("X-Original-Rows") || 0),
        originalCols: Number(res.headers.get("X-Original-Cols") || 0),
        outputRows: Number(res.headers.get("X-Output-Rows") || 0),
        outputCols: Number(res.headers.get("X-Output-Cols") || 0),
        duplicatesRemoved: Number(res.headers.get("X-Duplicates-Removed") || 0),
        emptyColsRemoved: Number(res.headers.get("X-Empty-Cols-Removed") || 0),
        normalizedDateCols: (res.headers.get("X-Normalized-Date-Cols") || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      };
      setStats(s);

      const blob = await res.blob();

      // get filename from Content-Disposition
      const cd = res.headers.get("Content-Disposition") || "";
      const match = cd.match(/filename="([^"]+)"/);
      const name = match?.[1] || `cleaned_${file.name}`;

      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);
      setDownloadName(name);
    } catch (e) {
      setError(e.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const clearAll = () => {
    pickVersion.current++;
    if (inputRef.current) inputRef.current.value = "";
    setFile(null);
    setHeaders([]);
    setSelected(new Set());
    setDownloadUrl("");
    setDownloadName("");
    setError("");
    setStats(null);
  };

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          <div className="p-6 sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold text-slate-900">CSV Cleaner</h1>
                <p className="mt-1 text-sm text-slate-600">
                  Turn messy exports into clean, consistent CSV files. Preview the changes, then download your result.
                </p>
                <p className="mt-1 text-xs font-medium uppercase tracking-wide text-emerald-700">
                  Less spreadsheet cleanup. More useful data.
                </p>
                <p className="mt-2 text-xs text-slate-600">
                  Common uses: Etsy exports · Shopify orders · CRM lists · Lead files
                </p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 whitespace-nowrap">
                Instant Download
              </span>
            </div>

            <div className="mt-6 grid gap-4">
              <label className={`block rounded-2xl border-2 border-dashed p-6 transition-colors ${dragging ? "border-emerald-500 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}
                onDragOver={(e) => { e.preventDefault(); if (!loading) setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); pickFile(e.dataTransfer.files?.[0]); }}>

                <span className="text-sm font-medium text-slate-800">Drop your CSV here, or choose a file</span>
                <div className="mt-2">
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    ref={inputRef}
                    disabled={loading}
                    onChange={(e) => pickFile(e.target.files?.[0])}
                    className="block w-full text-sm file:mr-4 file:rounded-xl file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800"
                  />
                </div>
                {file && (
                  <div className="mt-2 text-xs text-slate-600">
                    <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                      <span aria-hidden="true">OK</span>
                      <span className="truncate">{file.name}</span>
                    </span>
                  </div>
                )}
              </label>

              {!file && <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
                <span>UTF-8 CSV · Up to 20 MB</span>
                <button className="font-medium text-emerald-700 hover:underline" onClick={() => pickFile(new File(['Name,Email,ID,Empty\n Alice ,alice@example.com,00123, \n Alice ,alice@example.com,00123, \n Bob ,bob@example.com,00456, \n'], 'sample.csv', { type: 'text/csv' }))}>Try a sample CSV →</button>
              </div>}
              {file && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-slate-900">{file.name}</div>
                      <div className="text-xs text-slate-600">{bytes(file.size)}</div>
                    </div>
                    <button
                      onClick={clearAll}
                      disabled={loading}
                      className="text-xs font-medium text-slate-700 hover:text-slate-900"
                    >
                      Clear
                    </button>
                  </div>

                  <div className="mt-4">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium text-slate-800">
                        Remove duplicates by columns (optional)
                      </div>
                      <div className="text-xs text-slate-500">
                        {selectedList.length ? `${selectedList.length} selected` : "none"}
                      </div>
                    </div>

                    {headers.length ? (
                      <div className="mt-3 grid max-h-64 overflow-y-auto grid-cols-2 gap-2 sm:grid-cols-3">
                        {headers.map(({ raw, clean }) => (
                          <label
                            key={clean}
                            className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 hover:bg-slate-50"
                            title={`Sends: ${clean}`}
                          >
                            <input
                              type="checkbox"
                              checked={selected.has(clean)}
                              disabled={loading}
                              onChange={() => toggleCol(clean)}
                              className="h-4 w-4"
                            />
                            <span className="truncate">{raw}</span>
                          </label>
                        ))}

                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-slate-500">
                        (Couldn't preview headers - you can still clean the file.)
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3">
                    <div>
                      <div className="text-sm font-medium text-slate-800">Normalize dates</div>
                      <div className="text-xs text-slate-500">
                        Convert year-first dates to YYYY-MM-DD; preserve other values
                      </div>
                    </div>
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        disabled={loading}
                        aria-label="Normalize year-first dates"
                        checked={normalizeDates}
                        onChange={(e) => setNormalizeDates(e.target.checked)}
                        className="h-4 w-4"
                      />
                      <span className="text-slate-700">{normalizeDates ? "On" : "Off"}</span>
                    </label>
                  </div>
                </div>
              )}

              {error && (
                <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              )}

              <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
                <button
                  onClick={clean}
                  disabled={loading || !file}
                  className="rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? "Cleaning..." : "Clean CSV"}
                </button>

                {downloadUrl && (
                  <a
                    href={downloadUrl}
                    download={downloadName}
                    className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-900 hover:bg-slate-50"
                  >
                  Download cleaned CSV
                </a>
              )}
              </div>

              <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                <span aria-hidden="true">↗</span>
                <span>Files are processed once and never stored.</span>
              </div>

              {stats && (
                <div role="status" className="mt-2 rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-900">Cleaning complete</div>
                    <div className="text-xs text-slate-500">
                      {stats.originalRows.toLocaleString()}
                      {" -> "}
                      {stats.outputRows.toLocaleString()} rows
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="text-xs text-slate-500">Duplicates removed</div>
                      <div className="text-lg font-semibold text-slate-900">
                        {stats.duplicatesRemoved.toLocaleString()}
                      </div>
                    </div>

                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="text-xs text-slate-500">Empty columns removed</div>
                      <div className="text-lg font-semibold text-slate-900">
                        {stats.emptyColsRemoved.toLocaleString()}
                      </div>
                    </div>

                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="text-xs text-slate-500">Columns</div>
                      <div className="text-lg font-semibold text-slate-900">
                        {stats.originalCols}
                        {" -> "}
                        {stats.outputCols}
                      </div>
                    </div>

                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="text-xs text-slate-500">Date columns normalized</div>
                      <div className="text-sm font-medium text-slate-900 break-words">
                        {stats.normalizedDateCols.length ? stats.normalizedDateCols.join(", ") : "None"}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="text-xs text-slate-500">
                Tip: if you select columns, duplicates are removed based on those columns only.
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 text-center text-xs text-slate-600">
          No signup · Instant download · Files never stored
        </div>
      </div>
    </main>
  );
}
