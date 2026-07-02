/**
 * SPDX-License-Identifier: MIT
 * Veriton demo route — DeFi execution attestation.
 *
 * A paid agent endpoint: the buyer pays the agent to supply USDC to Aave on
 * their behalf. The agent returns its claim AND a signed ONCHAIN_STATE
 * assertion binding that claim to a re-checkable fact: the buyer's aToken
 * balance must be >= the supplied amount.
 *
 * Honest agent  -> aToken balance >= amount -> assertion holds -> challenge fails
 * Lying agent   -> aToken balance <  amount -> fabrication      -> bond slashed
 *
 * Place at: app/api/premium/defi-execute/route.ts
 */

import { NextRequest, NextResponse } from "next/server";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import {
  withVerifiedGateway,
  Op,
  type OnchainAssertion,
} from "@/lib/verified-gateway";

const balanceOfAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

// Arc Testnet demo defaults (override per request).
const DEMO_ATOKEN = (process.env.DEMO_ATOKEN ?? "0x0000000000000000000000000000000000000000") as Hex;

const handler = async (req: NextRequest) => {
  const body = (await req.json().catch(() => ({}))) as {
    wallet?: Hex;
    aToken?: Hex;
    amount?: string; // human USDC, e.g. "100"
  };

  const wallet = body.wallet;
  if (!wallet) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 });
  }
  const aToken = (body.aToken ?? DEMO_ATOKEN) as Hex;
  const amountUsdc = body.amount ?? "100";

  // USDC / aUSDC: 6 decimals.
  const expected = BigInt(Math.round(parseFloat(amountUsdc) * 1e6));

  // The claim the agent is willing to be slashed over:
  //   "I supplied >= amount; therefore your aToken balance is >= amount."
  const assertion: OnchainAssertion = {
    claimType: "ONCHAIN_STATE",
    target: aToken,
    callData: encodeFunctionData({
      abi: balanceOfAbi,
      functionName: "balanceOf",
      args: [wallet],
    }),
    op: Op.GTE,
    expected,
  };

  // The human-facing deliverable, in Veriton's standard form.
  const output = `AAVE_SUPPLY_USDC=${amountUsdc};wallet=${wallet};status=executed`;

  return NextResponse.json({ output, assertion });
};

export const POST = withVerifiedGateway(
  handler,
  "$0.01",
  "/api/premium/defi-execute",
);
