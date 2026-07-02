// 自己完結 envelope generator(Next 依存なし)。
// encodeAssertion 相当を verified-gateway.ts からインライン展開:
//   abi.encode(address target, bytes callData, uint8 op, uint256 expected), Op.GTE=0
import {
  encodeAbiParameters, parseAbiParameters,
  encodeFunctionData, parseAbi, keccak256, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const wallet = (process.argv[2] ?? "") as Hex;
const aToken = (process.argv[3] ?? process.env.DEMO_ATOKEN ?? "") as Hex;
const amount = process.argv[4] ?? "100";
if (!wallet || !aToken) { console.error("usage: gen-envelope <wallet> <aToken> [amount]"); process.exit(1); }

const callData = encodeFunctionData({
  abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
  functionName: "balanceOf",
  args: [wallet],
});
const OP_GTE = 0;
const expected = BigInt(Math.round(parseFloat(amount) * 1e6));

const evidence = encodeAbiParameters(
  parseAbiParameters("address, bytes, uint8, uint256"),
  [aToken, callData, OP_GTE, expected],
);
const outputHash = keccak256(evidence);
const account    = privateKeyToAccount(process.env.SELLER_PRIVATE_KEY as Hex);
const signature  = await account.signMessage({ message: { raw: outputHash } });

console.log(JSON.stringify({ outputHash, evidence, signature, signer: account.address }, null, 2));
