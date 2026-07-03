// Offline test for lib/veriton-verify.ts — no RPC needed for cases 1-4;
// case 5 asserts that an unreachable RPC yields NO VERDICT, not FABRICATED.
import {
  encodeAbiParameters, parseAbiParameters, encodeFunctionData,
  parseAbi, keccak256, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseEnvelope, verifyEnvelope } from "./lib/veriton-verify.ts";

const key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const account = privateKeyToAccount(key);

const callData = encodeFunctionData({
  abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
  functionName: "balanceOf",
  args: [account.address],
});
const evidence = encodeAbiParameters(
  parseAbiParameters("address, bytes, uint8, uint256"),
  ["0x700610Ee6ca6Fd17Fa274B1966C7e0559157907e", callData, 0, BigInt(100000000)],
);
const outputHash = keccak256(evidence);
const signature = await account.signMessage({ message: { raw: outputHash } });
const envelope = { outputHash, evidence, signature, signer: account.address };

let failures = 0;
function expect(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// 1) bare envelope parses
const p1 = parseEnvelope(JSON.stringify(envelope));
expect("parse: bare envelope", p1.ok);

// 2) full seller-response shape parses (withVerifiedGateway output)
const p2 = parseEnvelope(JSON.stringify({ output: { supplied: "100" }, verification: envelope }));
expect("parse: .verification wrapper", p2.ok && p2.ok === true && p2.envelope.outputHash === outputHash);

// 3) garbage rejected with message
const p3 = parseEnvelope("not json");
expect("parse: garbage rejected", !p3.ok);

// 4) tampered evidence → INVALID_ENVELOPE at binding, later steps skipped
const tampered = { ...envelope, evidence: (evidence.slice(0, -2) + "ff") as Hex };
const r4 = await verifyEnvelope(tampered);
expect("verdict: tampered evidence → INVALID_ENVELOPE", r4.verdict === "INVALID_ENVELOPE", r4.verdict);
expect("  steps: binding failed", r4.steps[0].status === "fail");
expect("  steps: rerun skipped", r4.steps[3].status === "skip");

// 5) wrong signer → INVALID_ENVELOPE at signature
const wrongSigner = { ...envelope, signer: "0x700610Ee6ca6Fd17Fa274B1966C7e0559157907e" };
const r5 = await verifyEnvelope(parseEnvelope(JSON.stringify(wrongSigner)).ok ? (parseEnvelope(JSON.stringify(wrongSigner)) as { ok: true; envelope: typeof envelope }).envelope : envelope);
expect("verdict: wrong signer → INVALID_ENVELOPE", r5.verdict === "INVALID_ENVELOPE", r5.verdict);
expect("  steps: binding passed", r5.steps[0].status === "pass");
expect("  steps: signature failed", r5.steps[1].status === "fail");

// 6) valid envelope, real RPC reachable, but the test wallet actually holds
//    0 (never funded) while the assertion claims ≥100 USDC → FABRICATED.
//    This is the correct verdict when RPC is up: "no answer" and "false
//    answer" are different things, and this case is the latter.
const r6 = await verifyEnvelope(envelope);
expect("verdict: unfunded wallet, RPC up → FABRICATED", r6.verdict === "FABRICATED", r6.verdict);
expect("  steps: binding/signature/decode all pass", r6.steps[0].status === "pass" && r6.steps[1].status === "pass" && r6.steps[2].status === "pass");
expect("  steps: rerun failed (actual 0 < expected)", r6.steps[3].status === "fail");

// 7) same envelope against an RPC URL that cannot resolve → RPC_UNREACHABLE,
//    never FABRICATED. This is the actual "no answer ≠ false answer" test.
const origEnv = process.env.NEXT_PUBLIC_ARC_RPC_URL;
process.env.NEXT_PUBLIC_ARC_RPC_URL = "http://127.0.0.1:1"; // nothing listens here
const r7 = await verifyEnvelope(envelope);
process.env.NEXT_PUBLIC_ARC_RPC_URL = origEnv;
expect("verdict: RPC unreachable → RPC_UNREACHABLE (not FABRICATED)", r7.verdict === "RPC_UNREACHABLE", r7.verdict);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
