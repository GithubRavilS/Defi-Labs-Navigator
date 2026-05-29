/**
 * Публичные данные навигатора напрямую из Google Sheets (без GAS).
 * GET /api/sheet-data — JSON для index.html (резерв / основной источник на Vercel).
 */
const { getNavigatorDataFromSheets } = require("../lib/sheet-get-data");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }
  try {
    const data = await getNavigatorDataFromSheets();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=120");
    res.status(200).send(JSON.stringify(data));
  } catch (e) {
    console.error("sheet-data", e);
    res.status(500).json({
      error: String(e.message || e).slice(0, 300),
      categories: [],
      tools: [],
    });
  }
};
