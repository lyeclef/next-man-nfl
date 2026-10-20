// RFC 4180 fields, including quoted commas, escaped quotes and embedded newlines.
export function parseCSV(text) {
  const rows = []; let row = [], field = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (quoted) throw new Error('CSV has an unterminated quoted field.');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const header = rows.shift() ?? [];
  if (new Set(header).size !== header.length) throw new Error('CSV contains duplicate column names.');
  return rows.filter(r => r.some(Boolean)).map((r, index) => {
    if (r.length !== header.length) throw new Error(`CSV row ${index + 2} has the wrong number of columns.`);
    return Object.fromEntries(header.map((h, i) => [h, r[i]]));
  });
}
