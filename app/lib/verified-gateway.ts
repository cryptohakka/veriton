/**
 * SPDX-License-Identifier: MIT
 * Veriton — the honesty layer for x402.
 *
 * withVerifiedGateway: wraps a paid route handler so the seller's output is
 * cryptographically bound to an on-chain-checkable assertion BEFORE it is
 * returned to the buyer. Turns "pay and pray" into "pay and verify".
 *
 * NOTE: Circle's withGateway (lib/x402.ts, Apache-2.0) is used UNMODIFIED.
 * We wrap the *handler*, not the gateway — composition keeps the license
 * boundary clean: nothing here touches Circle code.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { withGateway } from "./x402"; // Circle, Apache-2.0, vendored verbatim
import { toJsonSafe } from "./json-bigint";

// Mirrors BondVault.sol  enum Op { GTE, LTE, EQ, GT, LT, NEQ }
export enum Op {
  GTE = 0,
  LTE = 1,
  EQ = 2,
  GT = 3,
  LT = 4,
  NEQ = 5,
}

/**
 * The provider's claim. For the (c) (ONCHAIN_STATE) path this is exactly what
 * BondVault._verifyOnchainClaim re-runs via staticcall.
 *   fabricated  <=>  NOT( actual(target,callData)  Op  expected )
 */
export interface OnchainAssertion {
  claimType: "ONCHAIN_STATE";
  target: Hex; // contract to staticcall (e.g. aToken)
  callData: Hex; // view call (e.g. balanceOf(agentWallet))
  op: Op;
  expected: bigint; // compared against decoded staticcall result
}

const sellerKey = process.env.SELLER_PRIVATE_KEY as Hex;

/**
 * The exact bytes BondVault._verifyOnchainClaim decodes:
 *   abi.decode(evidence, (address, bytes, Op, uint256))
 * The buyer submits THESE bytes verbatim to challenge() — re-encoding them
 * from the JSON assertion risks a 1-byte ABI mismatch and "evidence mismatch".
 * -- this line is the single point where off-chain and on-chain must agree. --
 */
export function encodeAssertion(a: OnchainAssertion): Hex {
  return encodeAbiParameters(
    parseAbiParameters("address, bytes, uint8, uint256"),
    [a.target, a.callData, a.op, a.expected],
  );
}

/**
 * outputHash MUST byte-match BondVault's binding:
 *   keccak256(evidence)  with  evidence == abi.encode(target, callData, op, expected)
 */
export function computeOutputHash(a: OnchainAssertion): Hex {
  return keccak256(encodeAssertion(a));
}

/**
 * Wrap a handler so its JSON response is augmented with a signed assertion.
 * The handler MUST return JSON of shape: { output: ..., assertion: OnchainAssertion }
 */
function verifyAndSign(
  handler: (req: NextRequest) => Promise<NextResponse>,
): (req: NextRequest) => Promise<NextResponse> {
  return async (req: NextRequest) => {
    const response = await handler(req);

    // Only sign successful JSON responses carrying an assertion.
    const ct = response.headers.get("content-type") ?? "";
    if (!response.ok || !ct.includes("application/json")) {
      return response; // nothing to bind (error path / non-JSON) — pass through
    }

    let body: { output?: unknown; assertion?: OnchainAssertion };
    try {
      body = await response.json();
    } catch {
      return response;
    }

    const assertion = body.assertion;
    if (!assertion || assertion.claimType !== "ONCHAIN_STATE") {
      // A withVerifiedGateway endpoint that asserts nothing is a misconfig:
      // it would re-create "pay and pray". Fail loud rather than ship unsigned.
      console.error("[veriton] handler returned no ONCHAIN_STATE assertion");
      return NextResponse.json(
        { error: "Seller endpoint produced no verifiable assertion" },
        { status: 500 },
      );
    }

    // The provider-signed bytes. The buyer relays `evidence` UNCHANGED to
    // BondVault.challenge(); `outputHash` is what BondVault binds it against.
    const evidence = encodeAssertion(assertion);
    const outputHash = keccak256(evidence);

    const account = privateKeyToAccount(sellerKey);
    // EIP-191 personal_sign over the 32-byte hash — matches OZ
    // MessageHashUtils.toEthSignedMessageHash + ECDSA.tryRecover on-chain.
    const signature = await account.signMessage({
      message: { raw: outputHash },
    });

    // Rebuild the response, preserving the handler's headers, with the
    // verification envelope the buyer submits to BondVault.
    const headers = new Headers(response.headers);
    headers.delete("content-length"); // body size changed
    return NextResponse.json(
      toJsonSafe({
        ...body,
        verification: {
          outputHash,
          evidence, // <- pass verbatim to challenge(); never re-encode client-side
          signature,
          signer: account.address,
          assertion, // human-readable redundant copy (optional)
        },
      }),
      { status: response.status, headers },
    );
  };
}

/**
 * Drop-in replacement for withGateway. Same signature, same payment flow —
 * the only difference is the buyer receives a signed, challengeable assertion.
 */
export function withVerifiedGateway(
  handler: (req: NextRequest) => Promise<NextResponse>,
  price: string,
  endpoint: string,
) {
  return withGateway(verifyAndSign(handler), price, endpoint);
}
