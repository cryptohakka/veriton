/**
 * SPDX-License-Identifier: MIT
 * Veriton landing — replaces the Circle Sign-in scaffold entirely.
 * No auth: verification is public and read-only, so there is nothing
 * behind a login wall. This page is a plain server component — the
 * only client-side JS on the site lives in /verify, where it belongs.
 */

import Link from "next/link";
import { BONDVAULT_ADDRESS, EXPLORER_BASE } from "@/lib/veriton-verify";
import Image from "next/image";

const GITHUB_URL = "https://github.com/cryptohakka/veriton";

// ───────────────────────── shared bits ─────────────────────────

function Stamp({
  children,
  tone = "ink",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "ink" | "verified" | "fabricated" | "slashed";
  className?: string;
}) {
  const tones = {
    ink: "text-slate-800 border-slate-800 bg-white",
    verified: "text-[#0E7B4F] border-[#0E7B4F] bg-[#EAF6F0]",
    fabricated: "text-[#BE3B2E] border-[#BE3B2E] bg-[#FBEDEB]",
    slashed: "text-[#A85B10] border-[#A85B10] bg-[#FBF3E7]",
  } as const;
  return (
    <span
      className={`inline-block -rotate-2 border-4 border-double px-4 py-1.5 font-mono font-bold uppercase tracking-[0.2em] ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

const shortAddr = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

// ───────────────────────── page ─────────────────────────

export default function Home() {
  return (
    <main className="min-h-screen bg-white text-slate-900">
      {/* nav */}
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <span className="font-mono text-sm font-bold uppercase tracking-[0.25em] text-slate-800">
          Veriton
        </span>
        <nav className="flex items-center gap-6 font-mono text-xs uppercase tracking-wide text-slate-500">
          <Link href="/verify" className="hover:text-slate-900">
            Verify
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="hover:text-slate-900"
          >
            GitHub
          </a>
        </nav>
      </header>

      {/* hero */}
      <section className="mx-auto max-w-3xl px-6 pb-16 pt-10 text-center">
        <div
          style={{ animationDelay: "80ms" }}
          className="motion-safe:animate-[veriton-stamp_.4s_ease-out_both]"
        >
          <Stamp tone="ink">The honesty layer for x402</Stamp>
        </div>
        <h1 className="mt-8 text-4xl font-semibold leading-tight tracking-tight text-slate-900 sm:text-5xl">
          Pay agents you&apos;ve never met.
          <br />
          Verify before you trust.
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-slate-600">
          x402 lets any agent charge any agent, instantly. Veriton makes the
          receipts hold up: sellers back their claims with a bond, buyers
          verify for free, and lying about a paid output costs more than it
          could ever earn.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link
            href="/verify"
            className="rounded-md bg-slate-900 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700"
          >
            Verify an envelope
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-slate-300 px-6 py-2.5 text-sm text-slate-700 transition-colors hover:border-slate-500"
          >
            View on GitHub
          </a>
        </div>
      </section>

      {/* why-veriton visual: problem vs fix, mirrors the verdict stamps below */}
      <section className="border-y border-slate-100 bg-white">
        <div className="mx-auto max-w-5xl px-6 py-14">
          <Image
            src="/veriton-hero-light.png"
            alt="Without Veriton: pay and pray, no way to check a claim. With Veriton: every paid claim ends verified, fabricated, or already slashed."
            width={1400}
            height={640}
            className="w-full h-auto"
          />
        </div>
      </section>

      {/* scenario */}
      <section className="border-y border-slate-100 bg-slate-50/60">
        <div className="mx-auto max-w-3xl px-6 py-14">
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-slate-400">
            Why this exists
          </p>
          <p className="mt-3 text-lg leading-relaxed text-slate-700">
            Your treasury agent finds an unfamiliar executor agent in an open
            marketplace and pays it $0.01 to supply USDC into Aave. The
            executor replies:{" "}
            <span className="font-mono text-slate-900">
              &quot;done.&quot;
            </span>{" "}
            Today, that&apos;s the end of the story — you paid, and you hope.
            With Veriton, the reply carries a signed, checkable claim. Your
            agent confirms it against live chain state in one free call
            before it ever trusts the output. If the executor lied, one
            transaction slashes its bond — and 60% of it comes to you.
          </p>
        </div>
      </section>

      {/* three verdicts */}
      <section className="mx-auto max-w-5xl px-6 py-16">
        <p className="text-center font-mono text-[11px] uppercase tracking-[0.25em] text-slate-400">
          Every claim ends here
        </p>
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-200 p-6">
            <Stamp tone="verified" className="text-xs">
              Verified
            </Stamp>
            <p className="mt-4 text-sm leading-relaxed text-slate-600">
              The claim holds against live Arc state. The seller keeps the
              payment — bond untouched, nothing to challenge.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 p-6">
            <Stamp tone="fabricated" className="text-xs">
              Fabricated
            </Stamp>
            <p className="mt-4 text-sm leading-relaxed text-slate-600">
              The claim fails re-execution. One challenge transaction slashes
              the bond — the buyer is compensated, the lie is expensive.
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 p-6">
            <Stamp tone="slashed" className="text-xs">
              Already slashed
            </Stamp>
            <p className="mt-4 text-sm leading-relaxed text-slate-600">
              One output, one penalty. The registry blocks replays — a
              fabrication can&apos;t be punished twice or drain a bond
              indefinitely.
            </p>
          </div>
        </div>
      </section>

      {/* how it works */}
      <section className="border-t border-slate-100 bg-slate-50/60">
        <div className="mx-auto max-w-3xl px-6 py-16">
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-slate-400">
            How it works
          </p>
          <ol className="mt-6 space-y-5">
            {[
              [
                "Bond",
                "A seller deposits USDC into BondVault before taking paid work. This is deterrence, not escrow — honest volume costs nothing.",
              ],
              [
                "Sign",
                "Each paid response carries a signed assertion: a specific on-chain fact, checkable by anyone, bound to its exact bytes.",
              ],
              [
                "Verify",
                "The buyer re-runs the exact check the contract would run — a free staticcall against live chain state. No wallet, no gas.",
              ],
              [
                "Slash",
                "If the claim is false, one transaction burns the bond. If it's true, nothing happens — that's the point.",
              ],
            ].map(([title, body], i) => (
              <li key={title} className="flex gap-4">
                <span className="mt-0.5 font-mono text-xs text-slate-400">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <p className="text-sm leading-relaxed text-slate-700">
                  <span className="font-medium text-slate-900">{title}.</span>{" "}
                  {body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* footer */}
      <footer className="mx-auto max-w-5xl px-6 py-10 font-mono text-[11px] text-slate-400">
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-6">
          <span>
            BondVault{" "}
            <a
              className="underline decoration-slate-200 underline-offset-2 hover:text-slate-600"
              href={`${EXPLORER_BASE}/address/${BONDVAULT_ADDRESS}`}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddr(BONDVAULT_ADDRESS)}
            </a>{" "}
            · Arc Testnet
          </span>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-slate-200 underline-offset-2 hover:text-slate-600"
          >
            github.com/cryptohakka/veriton
          </a>
        </div>
      </footer>

      <style>{`
        @keyframes veriton-stamp { from { opacity: 0; transform: rotate(-2deg) scale(1.15); } to { opacity: 1; transform: rotate(-2deg) scale(1); } }
      `}</style>
    </main>
  );
}
