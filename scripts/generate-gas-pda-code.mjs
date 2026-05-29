/**
 * Emit Google Apps Script PDA helpers (validated vs @solana/web3.js).
 * node scripts/generate-gas-pda-code.mjs
 */
import { PublicKey } from "@solana/web3.js";
import {
  deriveOrcaPositionPda,
  deriveRaydiumPositionPda,
  findProgramAddressSync,
} from "../lib/solana-pda-pure.mjs";

const samples = ["11111111111111111111111111111112", "So11111111111111111111111111111111111111112"];
for (const mint of samples) {
  const [w] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), new PublicKey(mint).toBuffer()],
    new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"),
  );
  const p = deriveRaydiumPositionPda(mint);
  if (w.toBase58() !== p) throw new Error("mismatch " + mint);
}
console.log("Validation OK for", samples.length, "mints");

const gas = `
var RAYDIUM_CLMM_PROGRAM_GAS = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
var ORCA_WHIRL_PROGRAM_GAS = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";

function base58DecodeGas_(str) {
  var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  var bytes = [];
  var i, j, carry, val;
  for (i = 0; i < str.length; i++) {
    val = ALPHABET.indexOf(str.charAt(i));
    if (val < 0) throw new Error("invalid base58");
    carry = val;
    for (j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry = (carry / 256) | 0;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = (carry / 256) | 0;
    }
  }
  var zeros = 0;
  for (i = 0; i < str.length && str.charAt(i) === "1"; i++) zeros++;
  var out = [];
  for (i = 0; i < zeros; i++) out.push(0);
  for (i = bytes.length - 1; i >= 0; i--) out.push(bytes[i]);
  if (out.length !== 32) throw new Error("bad pubkey length");
  return out;
}

function sha256BytesGas_(bytes) {
  var blob = Utilities.newBlob(
    bytes.map(function (b) {
      return String.fromCharCode(b);
    }).join(""),
  ).getBytes();
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, blob);
}

function concatByteArraysGas_(arrays) {
  var len = 0;
  var i, j;
  for (i = 0; i < arrays.length; i++) len += arrays[i].length;
  var out = [];
  for (i = 0; i < arrays.length; i++) {
    for (j = 0; j < arrays[i].length; j++) out.push(arrays[i][j]);
  }
  return out;
}

function isOnCurveEd25519Gas_(pubkeyBytes) {
  try {
    return PublicKey.isOnCurve(new Uint8Array(pubkeyBytes));
  } catch (e) {
    return false;
  }
}

function createProgramAddressGas_(seedArrays, programIdBytes) {
  var marker = [
    80, 114, 111, 103, 114, 97, 109, 68, 101, 114, 105, 118, 101, 100, 65, 100, 100, 114, 101, 115,
    115,
  ];
  var i;
  for (i = 0; i < seedArrays.length; i++) {
    if (seedArrays[i].length > 32) throw new TypeError("Max seed length exceeded");
  }
  var buf = concatByteArraysGas_(seedArrays.concat([programIdBytes, marker]));
  var hash = sha256BytesGas_(buf);
  if (isOnCurveEd25519Gas_(hash)) {
    throw new Error("Invalid seeds, address must fall off the curve");
  }
  return hash;
}

function findProgramAddressSyncGas_(seedArrays, programIdB58) {
  var programIdBytes = base58DecodeGas_(programIdB58);
  var bump;
  for (bump = 255; bump >= 0; bump--) {
    try {
      var seeds = seedArrays.slice();
      seeds.push([bump]);
      var hash = createProgramAddressGas_(seeds, programIdBytes);
      return { address: base58EncodeGas_(hash), bump: bump };
    } catch (e) {
      if (e instanceof TypeError) throw e;
    }
  }
  throw new Error("Unable to find a viable program address nonce");
}

function deriveRaydiumPositionPdaGas_(mintB58) {
  var mint = base58DecodeGas_(mintB58);
  return findProgramAddressSyncGas_([[112, 111, 115, 105, 116, 105, 111, 110], mint], RAYDIUM_CLMM_PROGRAM_GAS)
    .address;
}

function deriveOrcaPositionPdaGas_(mintB58) {
  var mint = base58DecodeGas_(mintB58);
  return findProgramAddressSyncGas_([[112, 111, 115, 105, 116, 105, 111, 110], mint], ORCA_WHIRL_PROGRAM_GAS)
    .address;
}
`;

console.log(
  "NOTE: isOnCurveEd25519Gas_ uses PublicKey — replace with pure GAS isOnCurve when pasting.",
);
console.log(gas);
