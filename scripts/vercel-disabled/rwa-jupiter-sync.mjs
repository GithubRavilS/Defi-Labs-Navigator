/**
 * Vercel serverless: RWA on-chain sync.
 * GET /api/rwa-jupiter-sync?wallet=...
 */
import {
  fetchRwaPositionsOnchain,
  rowsToUnifiedSheetLines,
} from "../lib/rwa-onchain-positions.mjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "GET only" });
  }

  const secret = process.env.RWA_UI_SYNC_SECRET || "";
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const wallet = String(req.query.wallet || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return res.status(400).json({ ok: false, error: "Invalid wallet" });
  }

  try {
    const result = await fetchRwaPositionsOnchain(wallet);
    return res.status(200).json({
      ok: true,
      wallet: result.wallet,
      count: result.count,
      source: result.source,
      rows: result.rows,
      sheetLines: rowsToUnifiedSheetLines(result.rows),
    });
  } catch (e) {
    console.error("rwa-jupiter-sync:", e);
    return res.status(500).json({
      ok: false,
      error: String(e.message || e).slice(0, 300),
    });
  }
}
