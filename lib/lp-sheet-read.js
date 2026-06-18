/**
 * Чтение LP-листа Public Portfolio через Google Sheets API (вычисленные формулы).
 */
const { getSheetsClient } = require("./sheet-get-data");

function colName(idx) {
  let n = idx + 1;
  let s = "";
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

async function loadLpSheetPayload(sheetId, sheetName) {
  const sheets = await getSheetsClient();
  const range = `'${String(sheetName).replace(/'/g, "''")}'!A:Z`;
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = data.values || [];
  if (!values.length) {
    return { headers: [], rows: [] };
  }
  const headers = values[0].map((h) => String(h ?? "").trim());
  const rows = values.slice(1).map((raw) => {
    const row = headers.map((_, i) => {
      const val = i < raw.length ? raw[i] : "";
      if (val == null) return "";
      if (typeof val === "number") return val;
      return String(val);
    });
    const letters = {};
    row.forEach((v, i) => {
      letters[colName(i)] = v;
    });
    return { cells: row, letters };
  });
  return { headers, rows };
}

module.exports = { loadLpSheetPayload };
