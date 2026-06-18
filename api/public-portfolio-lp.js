/**
 * LP-лист Public Portfolio — Google Sheets API (формулы → значения).
 * GET /api/public-portfolio-lp?sheetId=&sheetName=
 */
const { loadLpSheetPayload } = require("../lib/lp-sheet-read");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const sheetId = String(req.query.sheetId || req.query.id || "").trim();
  const sheetName = String(req.query.sheetName || req.query.name || "Public portfolio").trim();
  if (!sheetId) {
    res.status(400).json({ error: "missing_sheet_id" });
    return;
  }

  try {
    const payload = await loadLpSheetPayload(sheetId, sheetName);
    res.status(200).json({ ...payload, source: "google_sheets_api_v4" });
  } catch (err) {
    res.status(500).json({
      error: "sheet_fetch_failed",
      message: String(err?.message || err).slice(0, 300),
    });
  }
};
