/**
 * Derive Raydium/Orca position PDA from NFT mint.
 * GET /api/solana-pda?mint=...&program=raydium|orca
 */
import { deriveOrcaPositionPda, deriveRaydiumPositionPda } from "../lib/solana-pda-pure.mjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "GET only" });
  }

  const mint = String(req.query.mint || "").trim();
  const program = String(req.query.program || "raydium").toLowerCase();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return res.status(400).json({ ok: false, error: "Invalid mint" });
  }

  try {
    const pda = program === "orca" ? deriveOrcaPositionPda(mint) : deriveRaydiumPositionPda(mint);
    return res.status(200).json({ ok: true, mint, program, pda });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
}
