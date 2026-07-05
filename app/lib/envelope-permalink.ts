/**
 * SPDX-License-Identifier: MIT
 * Envelope permalinks — /verify?e=<base64url(envelope JSON)>
 *
 * The URL *is* the envelope: fully self-contained, no server lookup, no
 * database, no shortener. This is deliberate (protocol, not platform):
 * a permalink stays verifiable even if this app disappears, because the
 * canonical artifact — the seller's signed bytes — travels inside it.
 *
 * Works in both browser (atob/btoa) and Node (Buffer) so the offline
 * test can exercise the exact code the page ships.
 */

import { parseEnvelope, type Envelope } from "./veriton-verify.ts";

// ───────────────────────── base64url primitives ─────────────────────────

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

const toUrlSafe = (b64: string) =>
  b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromUrlSafe = (s: string) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return b64 + "=".repeat((4 - (b64.length % 4)) % 4);
};

// ───────────────────────── public API ─────────────────────────

/** Canonical 4-field envelope → compact JSON → base64url query value. */
export function encodeEnvelopeParam(e: Envelope): string {
  const compact = JSON.stringify({
    outputHash: e.outputHash,
    evidence: e.evidence,
    signature: e.signature,
    signer: e.signer,
  });
  return toUrlSafe(toBase64(new TextEncoder().encode(compact)));
}

/**
 * Query value → envelope. Re-uses parseEnvelope so a permalink is held to
 * exactly the same validity bar as a pasted envelope — no second grammar.
 */
export function decodeEnvelopeParam(param: string):
  | { ok: true; json: string; envelope: Envelope }
  | { ok: false; error: string } {
  let json: string;
  try {
    json = new TextDecoder().decode(fromBase64(fromUrlSafe(param)));
  } catch {
    return { ok: false, error: "Malformed permalink: query value is not base64url." };
  }
  const parsed = parseEnvelope(json);
  if (!parsed.ok) {
    return { ok: false, error: `Permalink decoded, but envelope invalid: ${parsed.error}` };
  }
  return {
    ok: true,
    json: JSON.stringify(parsed.envelope, null, 2),
    envelope: parsed.envelope,
  };
}
