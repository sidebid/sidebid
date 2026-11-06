// Key handling and lamport maths, lifted from Project-1's treasury.js.
// The error messages are the valuable part: someone pasting five secret keys
// into Railway needs to know WHICH one is broken and why, without the key ever
// being echoed back at them.

import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";

export function sol(lamports) { return lamports / LAMPORTS_PER_SOL; }
export function lamports(solAmount) { return Math.round(solAmount * LAMPORTS_PER_SOL); }
// our own limiters pace the RPC; web3.js's silent 429 retries would stall payouts and reads for seconds
export function connect(url) { return new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: true }); }

export function unquote(v) {
  let s = String(v == null ? "" : v).trim();
  for (let i = 0; i < 6; i++) {
    const before = s;
    // Quotes, and the lone backslash an escaped quote leaves behind when the
    // quote itself has already been eaten. Neither character exists in base58
    // or in a Solana address, so at either end they can only be packaging.
    s = s.replace(/^[\\"'`]+/, "").replace(/[\\"'`]+$/, "").trim();
    if (s === before) break;
  }
  return s;
}

export function describeSecret(secret) {
  const raw = unquote(secret);
  if (!raw) return "empty";
  if (/^\[/.test(raw)) {
    try {
      const arr = JSON.parse(raw);
      return arr.length === 64 ? null : "a number array of " + arr.length + " bytes, expected 64";
    } catch { return "starts with [ but is not valid JSON"; }
  }
  if (/PASTE|HERE|YOUR_|XXXX/i.test(raw)) return "still a placeholder (" + raw.length + " characters)";
  if (/["']/.test(raw)) return "has a quote character in it — paste the key only, without quotes";
  const bad = raw.match(/[^1-9A-HJ-NP-Za-km-z]/g);
  if (bad) {
    const set = [...new Set(bad)];
    if (set.every((c) => /\s/.test(c))) return "has a space or line break inside it";
    if (set.some((c) => c === "\\" || c === '"' || c === "'")) {
      return "has a quote or backslash inside it, not just around it — check for a stray " +
             "separator where two keys meet";
    }
    const uniq = set.filter((c) => !/\s/.test(c)).slice(0, 4).map((c) => "'" + c + "'").join(", ");
    return "contains " + uniq + " — base58 has no 0, capital O, capital I or lowercase l, " +
           "so a look-alike may have been typed in place of one";
  }
  if (raw.length < 80) return "only " + raw.length + " characters — a Phantom key is about 88, so this looks truncated";
  if (raw.length > 100) return raw.length + " characters — too long, two keys may have run together";
  try {
    const b = bs58.decode(raw);
    if (b.length !== 64) return "decodes to " + b.length + " bytes, expected 64";
  } catch (e) { return e.message; }
  return null;
}

export function keypairFromSecret(secret) {
  if (!secret) throw new Error("missing secret key");
  const raw = unquote(secret);
  const why = describeSecret(raw);
  if (why) throw new Error(why);
  const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
  if (bytes.length !== 64) throw new Error("secret key must be 64 bytes");
  return Keypair.fromSecretKey(bytes);
}
