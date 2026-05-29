/**
 * Pure JS Solana PDA — validated against @solana/web3.js PublicKey.findProgramAddressSync.
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const val = B58.indexOf(str[i]);
    if (val < 0) throw new Error("invalid base58");
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  for (let i = 0; i < str.length && str[i] === "1"; i++) zeros++;
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i];
  if (out.length !== 32) throw new Error("bad pubkey length " + out.length);
  return out;
}

export function base58Encode(bytes) {
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let str = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) str += "1";
  for (let i = digits.length - 1; i >= 0; i--) str += B58[digits[i]];
  return str;
}

function sha256(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest();
}

function concatBytes(arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

export function isOnCurveEd25519Sync(pubkey) {
  return PublicKey.isOnCurve(pubkey);
}

export function createProgramAddressSync(seeds, programIdBytes) {
  const parts = seeds.map((s) => (s instanceof Uint8Array ? s : new Uint8Array(s)));
  for (const s of parts) {
    if (s.length > 32) throw new TypeError("Max seed length exceeded");
  }
  const buf = concatBytes([...parts, programIdBytes, PDA_MARKER]);
  const hash = sha256(buf);
  if (isOnCurveEd25519Sync(hash)) {
    throw new Error("Invalid seeds, address must fall off the curve");
  }
  return hash;
}

export function findProgramAddressSync(seeds, programIdBase58) {
  const programId = base58Decode(programIdBase58);
  for (let bump = 255; bump >= 0; bump--) {
    try {
      const seedsWithBump = [...seeds, new Uint8Array([bump])];
      const address = createProgramAddressSync(seedsWithBump, programId);
      return { address: base58Encode(address), bump };
    } catch (e) {
      if (e instanceof TypeError) throw e;
    }
  }
  throw new Error("Unable to find a viable program address nonce");
}

export function deriveRaydiumPositionPda(mintBase58) {
  const mint = base58Decode(mintBase58);
  const seed = new TextEncoder().encode("position");
  return findProgramAddressSync([seed, mint], "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK")
    .address;
}

export function deriveOrcaPositionPda(mintBase58) {
  const mint = base58Decode(mintBase58);
  const seed = new TextEncoder().encode("position");
  return findProgramAddressSync([seed, mint], "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc")
    .address;
}
