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
async function readCsvHeaders(file, requestedDelimiter = "auto") {
  const text = (await file.slice(0, 1024 * 1024).text()).replace(/^\uFEFF/, "");
  let delimiter = requestedDelimiter;
  if (delimiter === "auto") {
    const counts = { ",": 0, ";": 0, "\t": 0 };
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') {
        if (inQuotes && text[i + 1] === '"') i++;
        else inQuotes = !inQuotes;
      } else if (!inQuotes) {
        if (text[i] === "\n" || text[i] === "\r") break;
        if (text[i] in counts) counts[text[i]]++;
      }
    }
    delimiter = file.name?.toLowerCase().endsWith(".tsv") ? "\t" : Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  }
  const raw = [];
  let value = "", quoted = false, ended = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (c === delimiter && !quoted) { raw.push(value); value = ""; }
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

  const [options, setOptions] = useState({ clean_headers: true, trim_cells: true, drop_empty_columns: true, remove_duplicates: true });
  const [delimiter, setDelimiter] = useState("auto");
  const [preview, setPreview] = useState(null);
  const invalidate = () => { setDownloadUrl(""); setStats(null); setPreview(null); };
  const [loading, setLoading] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadName, setDownloadName] = useState("");
  const [error, setError] = useState("");
  const [stats, setStats] = useState(null);

  useEffect(() => () => { if (downloadUrl) URL.revokeObjectURL(downloadUrl); }, [downloadUrl]);
  const selectedList = useMemo(() => Array.from(selected), [selected]);

  const pickFile = async (f, nextDelimiter = delimiter) => {
    if (!f || loading) return;
    const version = ++pickVersion.current;
    setFile(null);
    setHeaders([]);
    setSelected(new Set());
    setError("");
    setDownloadUrl("");
    setStats(null);
    setPreview(null);

    if (!f.size) return setError("This file is empty. Choose a CSV with data.");
    if (f.size > 20 * 1024 * 1024) return setError("Maximum file size is 20 MB.");

    if (!/\.(csv|tsv)$/i.test(f.name)) {
      setError("Please upload a .csv or .tsv file.");
      return;
    }

    setFile(f);
    setSelected(new Set());

    try {
      const h = await readCsvHeaders(f, nextDelimiter);
      if (version === pickVersion.current) setHeaders(h);
    } catch {
      if (version === pickVersion.current) setHeaders([]);
    }
  };

  const toggleCol = (clean) => {
    invalidate();
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
    setPreview(null);

    try {
      const form = new FormData();
      form.append("file", file);
      if (selectedList.length) form.append("dedupe_cols", selectedList.join(","));
      form.append("normalize_dates", String(normalizeDates));
      form.append("preview", "true");
      form.append("delimiter", delimiter);
      Object.entries(options).forEach(([key, value]) => form.append(key, String(value)));

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

      const result = await res.json();
      if (!result.before || !result.after || typeof result.csv !== "string") throw new Error("Preview unavailable. Please try again.");
      setStats(result.stats);
      setPreview({ before: result.before, after: result.after });
      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
      const name = result.filename || `cleaned_${file.name}`;

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
    setPreview(null);
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
                    accept=".csv,.tsv,text/csv,text/tab-separated-values"
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
                <span>UTF-8 CSV / TSV · Up to 20 MB</span>
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

                  <label className="mt-4 block text-sm font-medium text-slate-800">
                    File separator
                    <select value={delimiter} disabled={loading} onChange={(e) => { const value = e.target.value; setDelimiter(value); pickFile(file, value); }} className="mt-2 block w-full rounded-lg border border-slate-300 bg-white p-2 text-sm">
                      <option value="auto">Detect automatically</option><option value=",">Comma (,)</option><option value=";">Semicolon (;)</option><option value={"\t"}>Tab</option>
                    </select>
                    <span className="mt-1 block text-xs font-normal text-slate-500">Downloads use standard comma-separated CSV. Choose a separator if automatic detection reads columns incorrectly.</span>
                  </label>
                  <fieldset disabled={loading} className="mt-4 grid gap-3 sm:grid-cols-2">
                    <legend className="mb-3 text-sm font-semibold text-slate-900">Choose what to clean</legend>
                    {[["clean_headers", "Standardize headers", "Use unique lowercase names with underscores."], ["trim_cells", "Trim cell whitespace", "Remove spaces around values."], ["drop_empty_columns", "Drop empty columns", "Remove columns with only blank cells."], ["remove_duplicates", "Remove duplicate rows", "Keep the first matching row."]].map(([key, label, help]) => (
                      <label key={key} className="flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm">
                        <input type="checkbox" checked={options[key]} onChange={(e) => { setOptions({ ...options, [key]: e.target.checked }); invalidate(); }} className="mt-1" />
                        <span><span className="block font-medium text-slate-800">{label}</span><span className="text-xs text-slate-500">{help}</span></span>
                      </label>
                    ))}
                  </fieldset>
                  {options.remove_duplicates && <div className="mt-4">
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
                  </div>}
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
                        onChange={(e) => { setNormalizeDates(e.target.checked); invalidate(); }}
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
                  {loading ? "Cleaning..." : "Clean & preview"}
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

              {preview && <section aria-label="Before and after preview" className="space-y-4">
                <p className="text-xs text-slate-500">First 10 rows shown for each version. The download includes every cleaned row. Spaces are preserved in this preview.</p>
                {[["before", "Original file"], ["after", "Cleaned result"]].map(([key, title]) => (
                  <div key={key}>
                    <h2 className="mb-2 text-sm font-semibold text-slate-900">{title}</h2>
                    <div tabIndex={0} role="region" aria-label={`${title} table, scroll to view all columns`} className="max-h-72 overflow-auto rounded-xl border border-slate-200">
                      <table className="w-full text-left text-xs">
                        <caption className="sr-only">{title}, up to ten rows</caption>
                        <thead className="sticky top-0 bg-slate-100"><tr>{preview[key].columns.map((col, i) => <th key={i} scope="col" className="whitespace-pre border-b border-slate-200 px-3 py-2 font-semibold">{col || "(unnamed)"}</th>)}</tr></thead>
                        <tbody>{preview[key].rows.map((row, i) => <tr key={i} className="border-b border-slate-100 last:border-0">{row.map((cell, j) => <td key={j} className="whitespace-pre px-3 py-2">{cell === "" ? <span className="italic text-slate-400">empty</span> : cell}</td>)}</tr>)}</tbody>
                      </table>
                      {!preview[key].rows.length && <p className="p-3 text-xs text-slate-500">No data rows.</p>}
                      {!preview[key].columns.length && <p className="p-3 text-xs text-slate-500">All columns were empty. Turn off “Drop empty columns” to retain them.</p>}
                    </div>
                  </div>
                ))}
              </section>}
              {stats && (
                <div role="status" className="mt-2 rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-900">Review your changes</div>
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
