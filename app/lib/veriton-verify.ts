/**
 * SPDX-License-Identifier: MIT
 * Veriton — client-side envelope verification.
 *
 * This module is a faithful mirror of what BondVault does on-chain, in the
 * same order, with the same failure semantics:
 *
 *   1. binding    keccak256(evidence) == outputHash          (evidence mismatch)
 *   2. signature  EIP-191 recover(outputHash) == signer      (bad signature)
 *   3. decode     abi.decode(evidence, (address,bytes,Op,uint256))
 *   4. re-run     staticcall(target, callData) → uint256 vs expected
 *                 revert / short return == fabricated         (mirrors contract)
 *   5. registry   fraudSettled[outputHash], bondOf[signer]
 *
 * Everything here is read-only: eth_call costs no gas and needs no wallet.
 * A buyer agent runs exactly these steps before trusting a paid output.
 */

import {
  createPublicClient,
  http,
  keccak256,
  decodeAbiParameters,
  parseAbiParameters,
  recoverMessageAddress,
  isHex,
  getAddress,
  type Hex,
  type Address,
} from "viem";

// ───────────────────────── chain / addresses ─────────────────────────

export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_TESTNET_DEFAULT_RPC = "https://rpc.testnet.arc.network";

function arcTestnetChain() {
  return {
    id: ARC_TESTNET_CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: {
      default: {
        http: [process.env.NEXT_PUBLIC_ARC_RPC_URL ?? ARC_TESTNET_DEFAULT_RPC],
      },
    },
  } as const;
}

export const BONDVAULT_ADDRESS =
  "0xb1e5fd74a816d2f3Bee521D9c6aa42419D967b2D" as Address;

export const EXPLORER_BASE = "https://testnet.arcscan.app";

const BONDVAULT_ABI = [
  {
    type: "function",
    name: "fraudSettled",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "bondOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "lockedOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export function makeClient() {
  return createPublicClient({
    chain: arcTestnetChain(),
    transport: http(),
  });
}

// ───────────────────────── envelope parsing ─────────────────────────

export const OP_LABELS = ["≥", "≤", "==", ">", "<", "!="] as const; // Op enum order

export interface Envelope {
  outputHash: Hex;
  evidence: Hex;
  signature: Hex;
  signer: Address;
}

/**
 * Accepts either the bare envelope or a full seller API response that
 * carries it under `.verification` (the withVerifiedGateway shape).
 */
export function parseEnvelope(raw: string):
  | { ok: true; envelope: Envelope }
  | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Not valid JSON. Paste the seller response or the verification envelope." };
  }
  const obj = parsed as Record<string, unknown>;
  const v = (obj.verification ?? obj) as Record<string, unknown>;
  for (const key of ["outputHash", "evidence", "signature", "signer"]) {
    if (typeof v[key] !== "string" || !isHex(v[key] as string)) {
      return { ok: false, error: `Missing or non-hex field: ${key}` };
    }
  }
  return {
    ok: true,
    envelope: {
      outputHash: v.outputHash as Hex,
      evidence: v.evidence as Hex,
      signature: v.signature as Hex,
      signer: getAddress(v.signer as string),
    },
  };
}

// ───────────────────────── verification steps ─────────────────────────

export type StepStatus = "pass" | "fail" | "skip";

export interface StepResult {
  id: "binding" | "signature" | "decode" | "rerun" | "registry";
  label: string;
  status: StepStatus;
  detail: string;
}

export interface DecodedAssertion {
  target: Address;
  callData: Hex;
  op: number;
  expected: bigint;
}

export type Verdict =
  | "VERIFIED" // assertion holds against current chain state
  | "FABRICATED" // assertion fails → challengeable, bond will burn
  | "ALREADY_SLASHED" // fraudSettled — the chain has spoken
  | "INVALID_ENVELOPE" // cannot be attributed to signer — unpunishable, but also untrustworthy
  | "RPC_UNREACHABLE"; // chain state unknown — absence of an answer is not a verdict

export interface VerificationReport {
  verdict: Verdict;
  steps: StepResult[];
  assertion?: DecodedAssertion;
  actual?: bigint;
  bond?: { bondOf: bigint; lockedOf: bigint };
}

class NetworkDown extends Error {}

/** viem wraps transport failures as HttpRequestError somewhere in the cause chain. */
function isNetworkError(err: unknown): boolean {
  let e = err as { name?: string; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 6; depth++) {
    if (e.name === "HttpRequestError" || e.name === "TimeoutError") return true;
    e = e.cause as { name?: string; cause?: unknown } | undefined;
  }
  return false;
}

function applyOp(actual: bigint, op: number, expected: bigint): boolean {
  switch (op) {
    case 0: return actual >= expected;
    case 1: return actual <= expected;
    case 2: return actual === expected;
    case 3: return actual > expected;
    case 4: return actual < expected;
    case 5: return actual !== expected;
    default: return false;
  }
}

const USDC_UNIT = BigInt(1000000); // ES2017 target: no BigInt literals

export function formatUsdc(x: bigint): string {
  const whole = x / USDC_UNIT;
  const frac = (x % USDC_UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

/**
 * Runs the full transcript. Steps are ordered and gated exactly like the
 * contract: an envelope that fails binding or signature never reaches
 * re-execution — it is nobody's claim.
 */
export async function verifyEnvelope(
  env: Envelope,
): Promise<VerificationReport> {
  const steps: StepResult[] = [];

  // 1) binding — the single point where off-chain and on-chain must agree
  const recomputed = keccak256(env.evidence);
  const bound = recomputed === env.outputHash;
  steps.push({
    id: "binding",
    label: "Hash binding",
    status: bound ? "pass" : "fail",
    detail: bound
      ? `keccak256(evidence) = ${short(recomputed)} — matches outputHash`
      : `keccak256(evidence) = ${short(recomputed)} ≠ claimed ${short(env.outputHash)}`,
  });

  // 2) signature — EIP-191 over the raw 32-byte hash, same as BondVault
  let recovered: Address | null = null;
  try {
    recovered = await recoverMessageAddress({
      message: { raw: env.outputHash },
      signature: env.signature,
    });
  } catch {
    /* malformed signature */
  }
  const signed = recovered !== null && recovered === env.signer;
  steps.push({
    id: "signature",
    label: "Provider signature",
    status: signed ? "pass" : "fail",
    detail: signed
      ? `EIP-191 recovers ${short(env.signer)} — claim is attributable`
      : recovered
        ? `Recovered ${short(recovered)} ≠ declared signer ${short(env.signer)}`
        : "Signature malformed — recovers no address",
  });

  if (!bound || !signed) {
    // Unattributable ≠ fabricated. BondVault would refuse the challenge;
    // the buyer should refuse the output. Nobody's bond is at stake.
    steps.push(
      { id: "decode", label: "Decode assertion", status: "skip", detail: "Skipped — envelope not attributable" },
      { id: "rerun", label: "Re-execute on Arc", status: "skip", detail: "Skipped" },
      { id: "registry", label: "Slash registry & bond", status: "skip", detail: "Skipped" },
    );
    return { verdict: "INVALID_ENVELOPE", steps };
  }

  // 3) decode — abi.decode(evidence, (address, bytes, uint8, uint256))
  let assertion: DecodedAssertion;
  try {
    const [target, callData, op, expected] = decodeAbiParameters(
      parseAbiParameters("address, bytes, uint8, uint256"),
      env.evidence,
    );
    assertion = { target, callData, op, expected };
  } catch {
    steps.push(
      { id: "decode", label: "Decode assertion", status: "fail", detail: "Evidence does not decode as (address, bytes, uint8, uint256)" },
      { id: "rerun", label: "Re-execute on Arc", status: "skip", detail: "Skipped" },
      { id: "registry", label: "Slash registry & bond", status: "skip", detail: "Skipped" },
    );
    // Signed garbage IS the provider's problem — on-chain this would revert
    // inside challenge, but a buyer should treat it as an unverifiable claim.
    return { verdict: "INVALID_ENVELOPE", steps };
  }
  steps.push({
    id: "decode",
    label: "Decode assertion",
    status: "pass",
    detail: `staticcall ${short(assertion.target)} · result ${OP_LABELS[assertion.op] ?? "?"} ${assertion.expected.toString()}`,
  });

  const client = makeClient();

  // 4) re-execute — the verdict is a pure function of chain state
  let actual: bigint | undefined;
  let holds = false;
  let netDown = false;
  let rerunDetail: string;
  try {
    const ret = await client.call({
      to: assertion.target,
      data: assertion.callData,
    });
    const data = ret.data;
    if (!data || data.length < 2 + 64) {
      // revert-with-no-data path can't reach here (viem throws), but a
      // short return mirrors the contract's `ret.length < 32 → fabricated`.
      rerunDetail = "Return shorter than 32 bytes — target unreadable → fabricated";
    } else {
      actual = BigInt(`0x${data.slice(2, 66)}`); // first word, like abi.decode(ret,(uint256))
      holds = applyOp(actual, assertion.op, assertion.expected);
      rerunDetail = `actual = ${actual.toString()} · assertion ${holds ? "holds" : "FAILS"} (${actual.toString()} ${OP_LABELS[assertion.op] ?? "?"} ${assertion.expected.toString()} is ${holds})`;
    }
  } catch (err) {
    if (isNetworkError(err)) {
      // No answer from Arc is not evidence of fabrication — refuse to rule.
      netDown = true;
      rerunDetail = "Arc RPC unreachable — chain state unknown, no verdict";
    } else {
      // staticcall reverted / target not a contract → contract says fabricated
      rerunDetail = "staticcall reverted — verification target does not answer → fabricated";
    }
  }
  steps.push({
    id: "rerun",
    label: "Re-execute on Arc",
    status: holds ? "pass" : "fail",
    detail: rerunDetail,
  });

  // 5) registry — has the chain already burned this output? what backs the signer?
  let slashed = false;
  let bond: VerificationReport["bond"];
  let registryDetail = "";
  try {
    if (netDown) throw new NetworkDown();
    const [fraud, bondOf, lockedOf] = await Promise.all([
      client.readContract({
        address: BONDVAULT_ADDRESS,
        abi: BONDVAULT_ABI,
        functionName: "fraudSettled",
        args: [env.outputHash],
      }),
      client.readContract({
        address: BONDVAULT_ADDRESS,
        abi: BONDVAULT_ABI,
        functionName: "bondOf",
        args: [env.signer],
      }),
      client.readContract({
        address: BONDVAULT_ADDRESS,
        abi: BONDVAULT_ABI,
        functionName: "lockedOf",
        args: [env.signer],
      }),
    ]);
    slashed = fraud;
    bond = { bondOf, lockedOf };
    registryDetail = slashed
      ? "fraudSettled[outputHash] = true — this output has already been slashed"
      : `Not slashed · signer bond ${formatUsdc(bondOf)} USDC (${formatUsdc(lockedOf)} locked)`;
  } catch (err) {
    if (isNetworkError(err) || err instanceof NetworkDown) {
      netDown = true;
      registryDetail = "Arc RPC unreachable — fraudSettled / bondOf unknown";
    } else {
      registryDetail = "BondVault read failed — is the address deployed on this network?";
    }
  }
  steps.push({
    id: "registry",
    label: "Slash registry & bond",
    status: slashed ? "fail" : bond ? "pass" : "fail",
    detail: registryDetail,
  });

  // A missing registry answer poisons every branch: without fraudSettled we
  // cannot rule out ALREADY_SLASHED, so the only honest verdict is none.
  const verdict: Verdict =
    netDown || (!bond && !slashed)
      ? "RPC_UNREACHABLE"
      : slashed
        ? "ALREADY_SLASHED"
        : holds
          ? "VERIFIED"
          : "FABRICATED";

  return { verdict, steps, assertion, actual, bond };
}
