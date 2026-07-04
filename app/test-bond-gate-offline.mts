// Offline test for lib/bond-gate.ts — no RPC needed (reader is injected).
// Pins: (1) decision boundaries around freeBond / PENALTY, (2) lockedOf
// reduces free bond, (3) RPC failure fails CLOSED, (4) TTL cache serves
// without re-reading, (5) log lines carry the demo-critical fragments.
import type { Address } from "viem";
import {
  decideBondGate,
  formatGateLog,
  makeBondGate,
  PENALTY,
} from "./lib/bond-gate.ts";

const SELLER = "0x774113cF25814bBF6fF35e2FA169B7Df57D33613" as Address;

let failures = 0;
function expect(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// 1) boundaries: free bond below / at / above penalty
const d5 = decideBondGate({ bondOf: 5_000_000n, lockedOf: 0n }, 1n);
expect("decide: 5 USDC free, min 1 → refuse", !d5.ok && d5.liesCovered === 0n);

const d10 = decideBondGate({ bondOf: PENALTY, lockedOf: 0n }, 1n);
expect("decide: exactly 10 USDC free, min 1 → pass", d10.ok && d10.liesCovered === 1n);

const d25min2 = decideBondGate({ bondOf: 25_000_000n, lockedOf: 0n }, 2n);
expect("decide: 25 USDC free, min 2 → pass (2 covered)", d25min2.ok && d25min2.liesCovered === 2n);

const d25min3 = decideBondGate({ bondOf: 25_000_000n, lockedOf: 0n }, 3n);
expect("decide: 25 USDC free, min 3 → refuse", !d25min3.ok);

// 2) lockedOf reduces free bond (mirrors challenge-time lock)
const dLocked = decideBondGate({ bondOf: 20_000_000n, lockedOf: 10_000_000n }, 2n);
expect(
  "decide: 20 bonded, 10 locked, min 2 → refuse (free = 10)",
  !dLocked.ok && dLocked.freeBond === PENALTY && dLocked.liesCovered === 1n,
);

// pathological: locked > bond must clamp, not underflow
const dClamp = decideBondGate({ bondOf: 5n, lockedOf: 10n }, 1n);
expect("decide: locked > bond clamps to 0 free", !dClamp.ok && dClamp.freeBond === 0n);

// 3) fail closed on reader error
const failingGate = makeBondGate({
  seller: SELLER,
  reader: async () => {
    throw new Error("ECONNREFUSED rpc.testnet.arc.network");
  },
});
const gFail = await failingGate.check();
expect("gate: reader throws → refuse (fail closed)", !gFail.ok && gFail.reason === "unreadable");
expect("gate: fail-closed log names the cause", gFail.logLine.includes("fail closed"));

// 4) TTL cache: second check within TTL does not re-read
let reads = 0;
const cachedGate = makeBondGate({
  seller: SELLER,
  ttlMs: 60_000,
  reader: async () => {
    reads++;
    return { bondOf: 100_000_000n, lockedOf: 0n };
  },
});
const g1 = await cachedGate.check();
const g2 = await cachedGate.check();
expect("gate: single read within TTL", reads === 1 && !g1.fromCache && g2.fromCache);
expect("gate: pass verdict for 100 USDC free", g1.ok && g1.liesCovered === 10n);

// 5) log line fragments the demo depends on
const passLog = formatGateLog(SELLER, decideBondGate({ bondOf: 100_000_000n, lockedOf: 0n }, 1n));
const refuseLog = formatGateLog(SELLER, decideBondGate({ bondOf: 5_000_000n, lockedOf: 0n }, 1n));
expect("log: pass line shows coverage and → pay", passLog.includes("10 fabrications covered") && passLog.includes("→ pay"));
expect("log: refuse line names the principle", refuseLog.includes("REFUSED") && refuseLog.includes("unslashable"));

console.log(failures === 0 ? "\nAll bond-gate tests passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
