/**
 * Validate pure PDA vs @solana/web3.js and test wallet mints.
 * node scripts/test-solana-pda.mjs
 */
import { PublicKey } from "@solana/web3.js";
import {
  deriveOrcaPositionPda,
  deriveRaydiumPositionPda,
  findProgramAddressSync,
} from "../lib/solana-pda-pure.mjs";
import { fetchRwaPositionsOnchain } from "../lib/rwa-onchain-positions.mjs";

const RAY = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const ORCA = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const wallet = "GFVsoeaHSFYaXXxMdYqYPMvkD3wJH6xmR6umLceWzXxs";

const testMint = "11111111111111111111111111111112";
const seed = new TextEncoder().encode("position");
const mintBytes = new PublicKey(testMint).toBuffer();
const [web3Pda] = PublicKey.findProgramAddressSync(
  [Buffer.from("position"), mintBytes],
  new PublicKey(RAY),
);
const purePda = deriveRaydiumPositionPda(testMint);
if (web3Pda.toBase58() !== purePda) {
  console.error("PDA mismatch", web3Pda.toBase58(), purePda);
  process.exit(1);
}
console.log("PDA OK:", purePda);

const onchain = await fetchRwaPositionsOnchain(wallet);
console.log("On-chain LP:", onchain.count);
for (const r of onchain.rows.slice(0, 3)) {
  console.log(" ", r.platform, r.pair, r.apy);
}
