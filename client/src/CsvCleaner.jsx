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
  const [columnSearch, setColumnSearch] = useState("");
  const [previewTab, setPreviewTab] = useState("after");
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

  const filteredHeaders = headers.filter(({ raw }) => raw.toLowerCase().includes(columnSearch.toLowerCase()));
  return (
    <main className="csv-cleaner workspace">
      <header className="site-header">
        <a className="brand" href="/" aria-label="CSV Cleaner home"><span className="brand-icon" aria-hidden="true">▦</span>CSV Cleaner<span className="brand-tag">DATA TOOLS</span></a>
        <a className="studio-link" href="https://splashmaxcreative.com" target="_blank" rel="noreferrer">By Splashmax Creative ↗</a>
      </header>
      <div className="workspace-body">
        <section className="intro">
          <div><p className="eyebrow">A LITTLE LESS SPREADSHEET WORK</p><h1>Messy data.<br className="mobile-break" /> Clean start.</h1><p className="intro-copy">Tidy your exports, review every change, and get back to work.</p></div>
          <div className="intro-note"><span className="status-dot" />No account needed<span>CSV & TSV · Up to 20 MB</span></div>
        </section>
        <ol className="step-bar" aria-label="Cleaning progress">
          {[["Upload", true], ["Configure", !!file], ["Review & download", !!preview]].map(([label, active], i) => <li key={label} className={active ? "active" : ""}><span>{i + 1}</span>{label}</li>)}
        </ol>
        <div className="workbench">
          <aside className="setup-panel" aria-label="Upload and cleaning settings">
            <section className="panel upload-panel">
              <div className="panel-heading"><h2><span className="section-number">01</span>Your file</h2>{file && <button className="text-button" onClick={clearAll} disabled={loading}>Remove</button>}</div>
              <label className={`drop-zone ${dragging ? "is-dragging" : ""} ${file ? "has-file" : ""}`}
                onDragOver={(e) => { e.preventDefault(); if (!loading) setDragging(true); }} onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); pickFile(e.dataTransfer.files?.[0]); }}>
                <span className="upload-symbol" aria-hidden="true">{file ? "✓" : "↑"}</span>
                <strong>{file ? file.name : "Drop a file to get started"}</strong>
                <span>{file ? `${bytes(file.size)} · ${headers.length} columns detected` : "or browse files on your device"}</span>
                <input className="file-picker" type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" ref={inputRef} disabled={loading} onChange={(e) => pickFile(e.target.files?.[0])} aria-label={file ? "Replace CSV or TSV file" : "Choose CSV or TSV file"} />
                <span className="browse-button">{file ? "Replace file" : "Choose file"}</span>
              </label>
              {!file && <button className="sample-button" onClick={() => pickFile(new File(['Name,Email,ID,Empty\n Alice ,alice@example.com,00123, \n Alice ,alice@example.com,00123, \n Bob ,bob@example.com,00456, \n'], 'sample.csv', { type: 'text/csv' }))}>Just exploring? Try sample data <span>→</span></button>}
              {file && <label className="field-label">File separator<select value={delimiter} disabled={loading} onChange={(e) => { const value = e.target.value; setDelimiter(value); pickFile(file, value); }}><option value="auto">Detect automatically</option><option value=",">Comma (,)</option><option value=";">Semicolon (;)</option><option value={"\t"}>Tab</option></select></label>}
            </section>
            <section className={`panel settings-panel ${!file ? "awaiting-file" : ""}`}>
              <div className="panel-heading"><h2><span className="section-number">02</span>Make it yours</h2><span className="small-label">{Object.values(options).filter(Boolean).length + Number(normalizeDates)} enabled</span></div>
              <fieldset disabled={!file || loading} className="cleaning-options"><legend className="sr-only">Cleaning options</legend>
                {[["clean_headers", "Standardize headers", "Consistent names, ready for your next import."], ["trim_cells", "Trim extra spaces", "Remove whitespace around cell values."], ["drop_empty_columns", "Remove empty columns", "Keep only columns that contain data."], ["remove_duplicates", "Remove duplicate rows", "Keep the first matching record."]].map(([key, label, help]) => <label key={key} className="option-row"><span><strong>{label}</strong><small>{help}</small></span><input type="checkbox" role="switch" checked={options[key]} onChange={(e) => { setOptions({ ...options, [key]: e.target.checked }); invalidate(); }} /></label>)}
                <label className="option-row"><span><strong>Normalize dates <em>OPTIONAL</em></strong><small>Year-first dates to YYYY-MM-DD.</small></span><input type="checkbox" role="switch" checked={normalizeDates} onChange={(e) => { setNormalizeDates(e.target.checked); invalidate(); }} /></label>
              </fieldset>
              {file && options.remove_duplicates && <details className="advanced-options"><summary>Match duplicates by column <span>{selectedList.length ? `${selectedList.length} selected` : "All columns"}</span></summary><p>Select key columns, or leave all unchecked to compare complete rows.</p><input className="column-search" type="search" placeholder="Find a column…" aria-label="Search columns" value={columnSearch} onChange={(e) => setColumnSearch(e.target.value)} /><div className="column-list">{filteredHeaders.map(({raw, clean}) => <label key={clean} title={raw}><input type="checkbox" checked={selected.has(clean)} disabled={loading} onChange={() => toggleCol(clean)} /><span>{raw}</span></label>)}{!filteredHeaders.length && <p>No matching columns.</p>}</div></details>}
            </section>
            <div className="action-panel">{error && <div role="alert" className="error-message">{error}</div>}<button className="primary-button" onClick={clean} disabled={loading || !file}>{loading ? <><span className="loading-spinner" />Cleaning your file…</> : <>Clean & preview <span aria-hidden="true">→</span></>}</button><p>Processed in memory. Files are never stored.</p></div>
          </aside>
          <section className="results-panel panel" aria-label="File review">
            <div className="panel-heading results-heading"><h2><span className="section-number">03</span>Your clean slate</h2><span className={`result-badge ${preview ? "is-ready" : ""}`}>{preview ? "Ready to download" : "Preview workspace"}</span></div>
            {!preview ? <div className="empty-preview" aria-live="polite"><div className="sheet-illustration" aria-hidden="true"><div className="sheet-top"><i /><i /><i /></div>{[0,1,2,3].map(i => <div className="sheet-row" key={i}><i /><i /><i /></div>)}<span>✓</span></div><h3>{loading ? "A little tidying in progress." : file ? "Your file. Your rules." : "Good data starts here."}</h3><p>{loading ? "Preparing your cleaned file and comparison." : file ? "Choose your cleaning options, then select Clean & preview to compare the results." : "Upload an export or try the sample. Your original and cleaned data will appear here."}</p><div className="empty-features"><span>Keep leading zeros</span><span>Review before downloading</span></div></div> : <>
              <div className="metrics" role="status">{[["Rows kept", stats.outputRows.toLocaleString(), `of ${stats.originalRows.toLocaleString()} original`], ["Duplicates removed", stats.duplicatesRemoved.toLocaleString(), "matching rows"], ["Empty columns", stats.emptyColsRemoved.toLocaleString(), "removed"]].map(([label,value,note]) => <div key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}</div>
              <div className="preview-toolbar"><div className="preview-tabs" role="tablist" aria-label="Preview version">{[["after","Cleaned result"],["before","Original file"]].map(([key,label]) => <button key={key} id={`tab-${key}`} role="tab" aria-selected={previewTab === key} aria-controls="data-preview" tabIndex={previewTab === key ? 0 : -1} onKeyDown={(e) => { if (["ArrowLeft", "ArrowRight"].includes(e.key)) { const next = key === "after" ? "before" : "after"; setPreviewTab(next); document.getElementById(`tab-${next}`)?.focus(); } }} onClick={() => setPreviewTab(key)}>{label}</button>)}</div><span>First 10 rows · {preview[previewTab].columns.length} columns</span></div>
              <div id="data-preview" role="tabpanel" aria-labelledby={`tab-${previewTab}`} tabIndex={0} className="data-preview"><table><caption className="sr-only">{previewTab === "after" ? "Cleaned result" : "Original file"}, first ten rows</caption><thead><tr><th scope="col" className="row-number">#</th>{preview[previewTab].columns.map((col,i) => <th key={i} scope="col">{col || "(unnamed)"}</th>)}</tr></thead><tbody>{preview[previewTab].rows.map((row,i) => <tr key={i}><td className="row-number">{i+1}</td>{row.map((cell,j) => <td key={j}><div className="preview-cell">{cell === "" ? <span className="empty-cell">empty</span> : cell}</div></td>)}</tr>)}</tbody></table>{!preview[previewTab].rows.length && <p className="table-note">No data rows.</p>}{!preview[previewTab].columns.length && <p className="table-note">All columns were empty. Disable empty-column removal to keep them.</p>}</div>
              <div className="result-footer"><p>Showing a sample. Download includes all {stats.outputRows.toLocaleString()} cleaned rows.<span>Output: comma-separated CSV · {stats.outputCols} columns{stats.normalizedDateCols.length ? ` · Dates: ${stats.normalizedDateCols.join(", ")}` : ""}</span></p><a className="download-button" href={downloadUrl} download={downloadName}>↓ Download CSV</a></div>
            </>}
          </section>
        </div>
        <footer className="workspace-footer"><span>Made for everyday data cleanup.</span><span>Shopify · Etsy · CRM exports · Contact lists</span></footer>
      </div>
    </main>
  );
}
