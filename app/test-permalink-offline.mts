// Offline test for lib/envelope-permalink.ts — no RPC, no browser needed.
// Pins: (1) round-trip identity, (2) URL-safety of the encoding,
// (3) malformed / truncated params fail closed with a message,
// (4) permalink validity bar === parseEnvelope validity bar.
import {
  encodeAbiParameters, parseAbiParameters, encodeFunctionData,
  parseAbi, keccak256, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseEnvelope } from "./lib/veriton-verify.ts";
import { encodeEnvelopeParam, decodeEnvelopeParam } from "./lib/envelope-permalink.ts";

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
const raw = JSON.stringify({ outputHash, evidence, signature, signer: account.address });

let failures = 0;
function expect(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const parsed = parseEnvelope(raw);
if (!parsed.ok) throw new Error("fixture envelope must parse");
const envelope = parsed.envelope;

// 1) round trip: encode → decode restores the identical envelope
const param = encodeEnvelopeParam(envelope);
const rt = decodeEnvelopeParam(param);
expect("round-trip: decode succeeds", rt.ok);
if (rt.ok) {
  expect(
    "round-trip: fields identical",
    rt.envelope.outputHash === envelope.outputHash &&
      rt.envelope.evidence === envelope.evidence &&
      rt.envelope.signature === envelope.signature &&
      rt.envelope.signer === envelope.signer,
  );
}

// 2) URL safety: no '+', '/', '=', and survives URLSearchParams untouched
expect("encoding: url-safe alphabet", !/[+/=]/.test(param));
const viaQuery = new URLSearchParams(`e=${param}`).get("e");
expect("encoding: survives URLSearchParams", viaQuery === param);

// 3) malformed params fail closed
const bad1 = decodeEnvelopeParam("!!!not-base64!!!");
expect("reject: non-base64url input", !bad1.ok);
const bad2 = decodeEnvelopeParam(param.slice(0, Math.floor(param.length / 2)));
expect("reject: truncated param", !bad2.ok);

// 4) valid base64url of an invalid envelope is rejected via parseEnvelope
const junkParam = Buffer.from(JSON.stringify({ hello: "world" }))
  .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const bad3 = decodeEnvelopeParam(junkParam);
expect(
  "reject: valid b64, invalid envelope (same bar as parseEnvelope)",
  !bad3.ok && !bad3.ok === true && bad3.error.includes("Missing or non-hex"),
);

console.log(failures === 0 ? "\nAll permalink tests passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
