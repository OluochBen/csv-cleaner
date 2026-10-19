export const PRESET_KEY = 'csv-cleaner.presets.v1';
export const OPTION_KEYS = ['clean_headers', 'trim_cells', 'drop_empty_columns', 'remove_duplicates'];

// Whitelist settings only: files, preview rows and extra metadata are never retained.
export function normalizePresets(value) {
  if (!Array.isArray(value)) return [];
  const names = new Set();
  return value.filter(p => p && typeof p.name === 'string' && p.name.trim()
    && ['auto', ',', ';', '\t'].includes(p.delimiter)
    && typeof p.normalizeDates === 'boolean'
    && p.options && OPTION_KEYS.every(key => typeof p.options[key] === 'boolean')
    && Array.isArray(p.columns) && p.columns.every(c => typeof c === 'string' && c.length <= 256))
    .map(p => ({ name: p.name.trim().slice(0, 40), delimiter: p.delimiter,
      normalizeDates: p.normalizeDates,
      options: Object.fromEntries(OPTION_KEYS.map(key => [key, p.options[key]])),
      columns: [...new Set(p.columns)].slice(0, 1000) }))
    .filter(p => { const key = p.name.toLowerCase(); if (names.has(key)) return false; names.add(key); return true; })
    .slice(0, 10);
}

export function loadPresets(storage) {
  try { return normalizePresets(JSON.parse(storage.getItem(PRESET_KEY) || '[]')); }
  catch { return []; }
}

export function savePresetList(storage, presets) {
  const safe = normalizePresets(presets);
  storage.setItem(PRESET_KEY, JSON.stringify(safe));
  return safe;
}

export function presetColumns(preset, headers) {
  if (!preset.options.remove_duplicates) return [];
  const available = new Set(headers.map(h => h.clean));
  const missing = preset.columns.filter(c => !available.has(c));
  if (missing.length) throw new Error(`Preset needs columns missing from this file: ${missing.join(', ')}. Choose another preset or configure this file manually.`);
  return preset.columns;
}
