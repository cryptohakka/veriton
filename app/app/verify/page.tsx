"use client";

/**
 * SPDX-License-Identifier: MIT
 * Veriton verification panel — /verify
 *
 * What a buyer agent does internally, made visible: paste a seller's signed
 * envelope, watch the five checks a challenge would run, get the verdict.
 * Read-only throughout: no wallet, no gas, no writes.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  parseEnvelope,
  verifyEnvelope,
  formatUsdc,
  BONDVAULT_ADDRESS,
  EXPLORER_BASE,
  OP_LABELS,
  type VerificationReport,
  type StepResult,
} from "@/lib/veriton-verify";
import {
  encodeEnvelopeParam,
  decodeEnvelopeParam,
} from "@/lib/envelope-permalink";
import { DEMO_ENVELOPE, DEMO_ENVELOPE_READY } from "@/lib/demo-envelope";

// ───────────────────────── verdict presentation ─────────────────────────

const VERDICTS = {
  VERIFIED: {
    stamp: "VERIFIED",
    tone: "text-[#0E7B4F] border-[#0E7B4F] bg-[#EAF6F0]",
    copy: "The claim holds against live Arc state. Lying about it would have cost the signer their bond — that is why it is true.",
  },
  FABRICATED: {
    stamp: "FABRICATED",
    tone: "text-[#BE3B2E] border-[#BE3B2E] bg-[#FBEDEB]",
    copy: "The claim fails re-execution. One challenge transaction slashes the signer's bond — 60% of it compensates you.",
  },
  ALREADY_SLASHED: {
    stamp: "ALREADY SLASHED",
    tone: "text-[#A85B10] border-[#A85B10] bg-[#FBF3E7]",
    copy: "The chain has already burned this output. One output, one slash — replays are blocked at the contract.",
  },
  INVALID_ENVELOPE: {
    stamp: "INVALID ENVELOPE",
    tone: "text-slate-500 border-slate-400 bg-slate-50",
    copy: "This claim cannot be attributed to the signer, so no bond stands behind it. Nothing to slash — and nothing to trust.",
  },
  RPC_UNREACHABLE: {
    stamp: "NO VERDICT",
    tone: "text-slate-500 border-slate-400 bg-slate-50",
    copy: "Arc could not be reached, so chain state is unknown. No answer is not a verdict — retry, or point NEXT_PUBLIC_ARC_RPC_URL at another node.",
  },
} as const;

const STEP_ICON: Record<StepResult["status"], { glyph: string; cls: string }> = {
  pass: { glyph: "✓", cls: "text-[#0E7B4F]" },
  fail: { glyph: "✕", cls: "text-[#BE3B2E]" },
  skip: { glyph: "—", cls: "text-slate-400" },
};

// ───────────────────────── page ─────────────────────────

export default function VerifyPage() {
  const [raw, setRaw] = useState("");
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // /verify?e=<base64url(envelope)> — a permalink carries the envelope in
  // the URL itself (no server lookup), so opening one fills the panel and
  // runs the same read-only checks immediately. window.location is read in
  // an effect (client-only), which keeps this page free of Suspense.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    const param = new URLSearchParams(window.location.search).get("e");
    if (!param) return;
    const dec = decodeEnvelopeParam(param);
    if (!dec.ok) {
      setParseError(dec.error);
      return;
    }
    setRaw(dec.json);
    void run(dec.json);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const challengeCmd = useMemo(() => {
    if (!report || report.verdict !== "FABRICATED") return null;
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) return null;
    const e = parsed.envelope;
    return [
      `cast send ${BONDVAULT_ADDRESS} \\`,
      `  "challenge(address,bytes32,bytes,uint8,bytes)" \\`,
      `  ${e.signer} ${e.outputHash} \\`,
      `  ${e.signature} 2 ${e.evidence} \\`,
      `  --rpc-url $ARC_TESTNET_RPC_URL --private-key $YOUR_KEY`,
    ].join("\n");
  }, [report, raw]);

  async function run(input?: string) {
    const text = input ?? raw;
    setParseError(null);
    setReport(null);
    const parsed = parseEnvelope(text);
    if (!parsed.ok) {
      setParseError(parsed.error);
      return;
    }
    setBusy(true);
    try {
      setReport(await verifyEnvelope(parsed.envelope));
    } finally {
      setBusy(false);
    }
  }

  const verdict = report ? VERDICTS[report.verdict] : null;

  return (
    <main className="min-h-screen bg-white text-slate-900">
      <div className="mx-auto max-w-5xl px-6 py-10">
        {/* header */}
        <header className="mb-10">
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-slate-500">
            Veriton · the honesty layer for x402
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Verify before you trust
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">
            Paste a seller&apos;s signed envelope. This panel runs the exact
            checks a challenge would run on-chain — hash binding, signature,
            re-execution against live Arc state, slash registry. No wallet, no
            gas, no writes: the verdict is a pure function of chain state.
          </p>
        </header>

        <div className="grid gap-8 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          {/* left: input */}
          <section aria-label="Envelope input">
            <label
              htmlFor="envelope"
              className="font-mono text-[11px] uppercase tracking-[0.2em] text-slate-500"
            >
              Signed envelope · JSON
            </label>
            <textarea
              id="envelope"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              spellCheck={false}
              placeholder={`Paste the seller response or its "verification" object:\n\n{\n  "outputHash": "0x…",\n  "evidence":   "0x…",\n  "signature":  "0x…",\n  "signer":     "0x…"\n}`}
              className="mt-2 h-72 w-full resize-y rounded-md border border-slate-300 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800 outline-none placeholder:text-slate-400 focus:border-slate-500 focus:bg-white"
            />
            {parseError && (
              <p className="mt-2 text-xs text-[#BE3B2E]">{parseError}</p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                onClick={() => run()}
                disabled={busy || raw.trim() === ""}
                className="rounded-md bg-slate-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Verifying…" : "Verify envelope"}
              </button>
              {DEMO_ENVELOPE_READY && (
                <button
                  onClick={() => {
                    setRaw(DEMO_ENVELOPE);
                    void run(DEMO_ENVELOPE);
                  }}
                  disabled={busy}
                  className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 transition-colors hover:border-slate-500 disabled:opacity-40"
                >
                  Load live-evidence envelope
                </button>
              )}
              <button
                onClick={async () => {
                  const parsed = parseEnvelope(raw);
                  if (!parsed.ok) {
                    setParseError(parsed.error);
                    return;
                  }
                  setParseError(null);
                  const url = `${window.location.origin}/verify?e=${encodeEnvelopeParam(parsed.envelope)}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  } catch {
                    // clipboard denied (non-secure context / permissions):
                    // fall back to putting the URL where it can be copied.
                    window.prompt("Copy this permalink:", url);
                  }
                }}
                disabled={busy || raw.trim() === ""}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 transition-colors hover:border-slate-500 disabled:opacity-40"
              >
                {copied ? "Copied ✓" : "Copy permalink"}
              </button>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-slate-500">
              Envelopes come from any endpoint wrapped in{" "}
              <code className="font-mono">withVerifiedGateway</code>. The same
              bytes you verify here are the bytes a challenge submits — never
              re-encode them. Permalinks embed the full envelope in the URL —
              no server, no database — so a link stays verifiable even if this
              app disappears.
            </p>
          </section>

          {/* right: transcript + verdict */}
          <section aria-label="Verification transcript" aria-live="polite">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-slate-500">
              Verification transcript
            </p>
            <ol className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
              {(report?.steps ?? PLACEHOLDER_STEPS).map((s, i) => {
                const icon = report
                  ? STEP_ICON[s.status]
                  : { glyph: "·", cls: "text-slate-300" };
                return (
                  <li
                    key={s.id}
                    style={
                      report
                        ? { animationDelay: `${i * 120}ms` }
                        : undefined
                    }
                    className={`flex items-start gap-3 p-3 ${
                      report
                        ? "motion-safe:animate-[veriton-step_.35s_ease-out_both]"
                        : ""
                    }`}
                  >
                    <span
                      className={`mt-0.5 w-4 shrink-0 text-center font-mono text-sm ${icon.cls}`}
                      aria-hidden
                    >
                      {icon.glyph}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800">
                        <span className="mr-2 font-mono text-[11px] text-slate-400">
                          {i + 1}
                        </span>
                        {s.label}
                        {report && (
                          <span className="sr-only">
                            {" "}
                            — {s.status === "pass" ? "passed" : s.status === "fail" ? "failed" : "skipped"}
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 break-all font-mono text-xs leading-relaxed text-slate-500">
                        {report
                          ? s.detail
                          : (s as { placeholder?: string }).placeholder}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>

            {/* verdict stamp */}
            {verdict && report && (
              <div
                style={{ animationDelay: `${report.steps.length * 120 + 100}ms` }}
                className="mt-6 motion-safe:animate-[veriton-stamp_.4s_ease-out_both]"
              >
                <div
                  className={`inline-block -rotate-2 border-4 border-double px-6 py-3 font-mono text-xl font-bold uppercase tracking-[0.3em] ${verdict.tone}`}
                >
                  {verdict.stamp}
                </div>
                <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-600">
                  {verdict.copy}
                </p>

                {report.assertion && (
                  <p className="mt-3 font-mono text-xs text-slate-500">
                    claim: result of{" "}
                    <a
                      className="underline decoration-slate-300 underline-offset-2 hover:text-slate-800"
                      href={`${EXPLORER_BASE}/address/${report.assertion.target}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {report.assertion.target.slice(0, 10)}…
                    </a>{" "}
                    {OP_LABELS[report.assertion.op] ?? "?"}{" "}
                    {report.assertion.expected.toString()}
                    {report.actual !== undefined &&
                      ` · actual ${report.actual.toString()}`}
                  </p>
                )}

                {report.bond && (
                  <p className="mt-1 font-mono text-xs text-slate-500">
                    signer bond:{" "}
                    <a
                      className="underline decoration-slate-300 underline-offset-2 hover:text-slate-800"
                      href={`${EXPLORER_BASE}/address/${BONDVAULT_ADDRESS}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {formatUsdc(report.bond.bondOf)} USDC
                    </a>
                    {report.bond.lockedOf > BigInt(0) &&
                      ` (${formatUsdc(report.bond.lockedOf)} locked in challenges)`}
                  </p>
                )}

                {challengeCmd && (
                  <div className="mt-4">
                    <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-slate-500">
                      Slash it — one transaction
                    </p>
                    <pre className="mt-1 overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
                      {challengeCmd}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        <footer className="mt-14 border-t border-slate-100 pt-4 font-mono text-[11px] text-slate-400">
          BondVault{" "}
          <a
            className="underline decoration-slate-200 underline-offset-2 hover:text-slate-600"
            href={`${EXPLORER_BASE}/address/${BONDVAULT_ADDRESS}`}
            target="_blank"
            rel="noreferrer"
          >
            {BONDVAULT_ADDRESS}
          </a>{" "}
          · Arc Testnet · read-only
        </footer>
      </div>

      {/* keyframes for the transcript reveal — respects prefers-reduced-motion via motion-safe */}
      <style>{`
        @keyframes veriton-step { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        @keyframes veriton-stamp { from { opacity: 0; transform: rotate(-2deg) scale(1.15); } to { opacity: 1; transform: rotate(-2deg) scale(1); } }
      `}</style>
    </main>
  );
}

// idle-state placeholders so the transcript's shape is visible before input
const PLACEHOLDER_STEPS: (StepResult & { placeholder: string })[] = [
  { id: "binding", label: "Hash binding", status: "skip", detail: "", placeholder: "keccak256(evidence) must equal outputHash" },
  { id: "signature", label: "Provider signature", status: "skip", detail: "", placeholder: "EIP-191 recovery must yield the declared signer" },
  { id: "decode", label: "Decode assertion", status: "skip", detail: "", placeholder: "evidence decodes as (target, callData, op, expected)" },
  { id: "rerun", label: "Re-execute on Arc", status: "skip", detail: "", placeholder: "staticcall the target — the EVM is the verifier" },
  { id: "registry", label: "Slash registry & bond", status: "skip", detail: "", placeholder: "fraudSettled[outputHash] · bondOf[signer]" },
];
