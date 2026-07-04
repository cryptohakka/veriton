/**
 * SPDX-License-Identifier: MIT
 * Buyer-side bond gate — the README's slash-economics formula, running.
 *
 *   compensation capacity (lies covered) = freeBond / PENALTY
 *   freeBond                             = bondOf - lockedOf
 *
 * A seller whose free bond is below the penalty cannot even be challenged
 * (challenge() reverts "insufficient free bond" — pinned by
 * test_SubPenaltyBond_IsUnchallengeable), so paying such a seller means
 * paying with zero deterrence behind the response. This gate refuses to.
 *
 * Reference implementation: the threshold is the buyer's choice, not the
 * protocol's. Configure via minLiesCovered (default 1).
 *
 * RPC failure fails CLOSED. This is the opposite of /verify's
 * RPC_UNREACHABLE ("no answer is not a verdict") and deliberately so:
 * a verdict must not be invented, but a payment can always wait.
 */

import { makeClient, BONDVAULT_ADDRESS, formatUsdc } from "./veriton-verify";
import { parseAbi, type Address } from "viem";

/** Mirrors BondVault._penaltyFor (flat 10 USDC in the current deployment). */
export const PENALTY = BigInt(10_000_000);

const bondAbi = parseAbi([
  "function bondOf(address) view returns (uint256)",
  "function lockedOf(address) view returns (uint256)",
]);

// ───────────────────────── pure decision ─────────────────────────

export interface BondReading {
  bondOf: bigint;
  lockedOf: bigint;
}

export interface GateDecision {
  ok: boolean;
  freeBond: bigint;
  liesCovered: bigint; // freeBond / PENALTY, floor
  required: bigint; // minLiesCovered
  reason: "pass" | "insufficient" | "unreadable";
  detail?: string; // reader error message when unreadable
}

export function decideBondGate(
  reading: BondReading,
  minLiesCovered: bigint,
): GateDecision {
  const freeBond =
    reading.bondOf > reading.lockedOf ? reading.bondOf - reading.lockedOf : BigInt(0);
  const liesCovered = freeBond / PENALTY;
  return {
    ok: liesCovered >= minLiesCovered,
    freeBond,
    liesCovered,
    required: minLiesCovered,
    reason: liesCovered >= minLiesCovered ? "pass" : "insufficient",
  };
}

export function formatGateLog(seller: Address, d: GateDecision): string {
  const who = `${seller.slice(0, 6)}…${seller.slice(-4)}`;
  if (d.reason === "unreadable") {
    return `[VERITON] REFUSED ${who}: bond unreadable (${d.detail ?? "RPC error"}) — fail closed, not paying blind`;
  }
  const bond = `free bond ${formatUsdc(d.freeBond)} USDC`;
  const cover = `${d.liesCovered} fabrication${d.liesCovered === BigInt(1) ? "" : "s"} covered, min ${d.required}`;
  return d.ok
    ? `[VERITON] pass ${who}: ${bond} (${cover}) → pay`
    : `[VERITON] REFUSED ${who}: ${bond} (${cover}) — an unslashable seller is an unbonded seller`;
}

// ───────────────────────── chain reader + cached gate ─────────────────────────

export type BondReader = (seller: Address) => Promise<BondReading>;

/** Default reader: two eth_calls against BondVault via the shared client. */
export const readSellerBond: BondReader = async (seller) => {
  const client = makeClient();
  const [bondOf, lockedOf] = await Promise.all([
    client.readContract({
      address: BONDVAULT_ADDRESS,
      abi: bondAbi,
      functionName: "bondOf",
      args: [seller],
    }),
    client.readContract({
      address: BONDVAULT_ADDRESS,
      abi: bondAbi,
      functionName: "lockedOf",
      args: [seller],
    }),
  ]);
  return { bondOf, lockedOf };
};

export interface GateCheck extends GateDecision {
  logLine: string;
  fromCache: boolean;
}

/**
 * TTL-cached gate for payment loops. One RPC round per ttlMs, not per
 * payment; failures are cached too (a dead RPC should not be hammered).
 */
export function makeBondGate(opts: {
  seller: Address;
  minLiesCovered?: bigint;
  ttlMs?: number;
  reader?: BondReader; // injectable for offline tests
}) {
  const min = opts.minLiesCovered ?? BigInt(1);
  const ttl = opts.ttlMs ?? 15_000;
  const read = opts.reader ?? readSellerBond;

  let cached: GateCheck | null = null;
  let cachedAt = 0;

  return {
    seller: opts.seller,
    async check(): Promise<GateCheck> {
      const now = Date.now();
      if (cached && now - cachedAt < ttl) {
        return { ...cached, fromCache: true };
      }
      let decision: GateDecision;
      try {
        decision = decideBondGate(await read(opts.seller), min);
      } catch (err) {
        decision = {
          ok: false,
          freeBond: BigInt(0),
          liesCovered: BigInt(0),
          required: min,
          reason: "unreadable",
          detail: (err as Error).message?.slice(0, 80),
        };
      }
      cached = {
        ...decision,
        logLine: formatGateLog(opts.seller, decision),
        fromCache: false,
      };
      cachedAt = now;
      return cached;
    },
  };
}
