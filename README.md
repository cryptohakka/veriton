# Veriton — the honesty layer for x402

**Pay without praying.**

x402 lets agents pay each other per-request in USDC. But payment settles the moment the response arrives — before anyone knows whether the response is *true*. An agent that claims "I supplied your USDC to Aave" gets paid whether or not it did. Today's agentic economy runs on **pay-and-pray**.

Veriton adds the missing layer: sellers post a bond, sign their outputs, and get **slashed on-chain when a claim is provably fabricated**. No trusted oracle, no arbitration committee — only claims that anyone can re-verify deterministically.

## Two layers, zero changes to the payment rail

| Layer | What | Frequency |
|---|---|---|
| **Payment** | Circle Nanopayments (x402 + Gateway batching), used **unmodified** | Every request, sub-cent |
| **Collateral** | `BondVault.sol` on Arc — bond, challenge, slash | Only when fraud is alleged |

The seller wraps its paid endpoint with `withVerifiedGateway` (a composition over Circle's `withGateway` — Circle code is vendored verbatim under Apache-2.0, untouched). Every paid response then carries a **signed, challengeable assertion**: the exact bytes that `BondVault._verifyOnchainClaim` will re-check via `staticcall` if anyone challenges.

## What gets slashed — and what doesn't

Veriton slashes **deterministic fabrications only**:

1. Source-existence fraud (cited source does not exist)
2. Cited-value mismatch (quoted number differs from the source)
3. **On-chain execution fraud** (claimed a tx/state that the chain contradicts) ← live in v1

Quality, interpretation, and wrong-but-honest predictions are **never** slashed. That is the job of a reputation layer, not a penalty layer. Collapsing "lied" and "was wrong" into one score is how reputation systems get gamed; Veriton keeps them separate by construction.

## Why no trusted oracle

The assertion is bound before delivery:

```
outputHash == keccak256(abi.encode(target, callData, op, expected))
```

The seller signs `outputHash` (EIP-191). A challenger submits the seller's own signed bytes — nothing else is accepted (`evidence mismatch` otherwise), so honest sellers cannot be framed with crafted predicates. The contract re-runs `staticcall(target, callData)` itself and compares. Anyone can reproduce the verdict; nobody has to be trusted.

## Live evidence (Arc Testnet)

Both directions have been exercised on-chain against the deployed contracts:

| Case | What happened | Tx |
|---|---|---|
| **Fraud → slash** | Seller signed "aToken balance ≥ 100 USDC", balance was 0 → `Slashed` in the same tx as the challenge | `0x29c798c67372f2399987fd704b55832b873cf7d7b9bbb5d20fef7a2ac3bdfb52` |
| **Honest → reject** | Seller signed the same claim, balance really was 100 USDC → `ChallengeRejected`, bond untouched, challenger stake forfeited | `0x4dbb8f18418ef64770f7451d794fcceb23a416060daeca04760a1fe004e88132` |

Deployed addresses:

| Contract | Address |
|---|---|
| BondVault | `0x1A8D3bcD80c0acB45A28d05c7d612d0F2Ae7A8Cc` |
| MockAToken (demo verification target) | `0x700610Ee6ca6Fd17Fa274B1966C7e0559157907e` |
| USDC (Arc Testnet native) | `0x3600000000000000000000000000000000000000` |

Explorer: https://testnet.arcscan.app/address/0x1A8D3bcD80c0acB45A28d05c7d612d0F2Ae7A8Cc

## Slash economics

Penalty distribution is **60 / 20 / 20** — victim compensation / challenger reward / protocol. In v1 the victim and the challenger are assumed to be the same party (the buyer challenges on its own behalf), so `_slash` pays victim + challenger shares + stake refund to the challenger in one transfer; separating victim resolution is a v2 item and marked as such in the contract. False accusations cost the challenger their 1 USDC stake (forfeited to protocol on `_reject`).

## What is real vs. staged — honest disclosure

- **Layer 1 — contracts and verification: real.** BondVault is deployed on Arc Testnet; every slash/reject above is an immutable on-chain transaction anyone can inspect or reproduce with `cast`.
- **Layer 2 — the demo economy: staged by the operator.** Seller, buyer, and challenger wallets are all operated by the author. Note the incentive direction: in the fraud demo **the operator slashes their own seller's bond** — the demo is adverse to its own operator.
- **Layer 3 — external participants: none yet.** No third party has posted a bond or filed a challenge. We state this rather than simulate traction.

## Repository layout

```
onchain/   Foundry — BondVault.sol, tests (forge test)
app/       Next.js seller + agent (based on Circle's arc-nanopayments-demo)
  lib/verified-gateway.ts        Veriton wrapper (MIT) over Circle's withGateway (Apache-2.0)
  app/api/premium/defi-execute/  Veriton demo endpoint: paid DeFi execution + signed assertion
  gen-envelope.mts               canonical envelope generator (Node-only, no Next.js needed)
```

## Reproduce the honest-case flow

```bash
cd onchain && set -a; source .env; set +a
RPC=$ARC_TESTNET_RPC_URL

# seller posts bond
cast send $USDC_ADDR "approve(address,uint256)" $BONDVAULT_ADDR 10000000 --private-key $SELLER_PRIVATE_KEY --rpc-url $RPC
cast send $BONDVAULT_ADDR "depositBond(uint256)" 10000000 --private-key $SELLER_PRIVATE_KEY --rpc-url $RPC

# generate the signed envelope (assertion: aToken balance >= 100 USDC)
cd ../app && npx tsx gen-envelope.mts <sellerAddr> <aTokenAddr> 100

# challenge with the seller's own signed bytes (claimType 0 = ONCHAIN, verdict is immediate)
cast send $BONDVAULT_ADDR "challenge(address,bytes32,bytes,uint8,bytes)" \
  <sellerAddr> <outputHash> <signature> 0 <evidence> --private-key $PRIVATE_KEY --rpc-url $RPC
```

If the balance satisfies the assertion the tx emits `ChallengeRejected`; if not, `Slashed` — in the same transaction.

## License

MIT, except files vendored from Circle's arc-nanopayments-demo (notably `app/lib/x402.ts`), which retain their Apache-2.0 headers and are used unmodified.
