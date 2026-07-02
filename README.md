# Veriton — the honesty layer for x402

**Pay without praying.**

> **Demo video:** _coming soon_ <!-- TODO: replace with link after recording -->

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

All three verdicts have been exercised on-chain against the deployed contract — using the **same byte-identical signed envelope** (same `outputHash`, same signature); only the chain state differed between runs:

| Case | What happened | Tx |
|---|---|---|
| **Honest → reject** | Seller signed "aToken balance ≥ 100 USDC", balance really was 100 USDC → `ChallengeRejected`, bond untouched, challenger stake forfeited | `0xb6193fc27932de63d491e8c789249c0f3ecafe5d5a42902b16d4adb167448c14` |
| **Fraud → slash** | Balance dropped to 0, the very same envelope re-challenged → `Slashed` (10 USDC) in the same tx as the challenge | `0x02e790b9e7d45737b157e40ca098ee2d89c5fbe87353b9f8614fd8f20d8c61ae` |
| **Replay → blocked** | A third challenge with the same envelope reverts `output already slashed` — one output, one slash (reproducible as a gas-free `eth_call` by anyone) | — |

The first two rows are the system's core claim made concrete: the verdict is a pure function of chain state, not of anyone's opinion.

Deployed addresses:

| Contract | Address |
|---|---|
| BondVault | `0xb1e5fd74a816d2f3Bee521D9c6aa42419D967b2D` |
| MockAToken (demo verification target) | `0x700610Ee6ca6Fd17Fa274B1966C7e0559157907e` |
| USDC (Arc Testnet native) | `0x3600000000000000000000000000000000000000` |

Explorer: https://testnet.arcscan.app/address/0xb1e5fd74a816d2f3Bee521D9c6aa42419D967b2D

## Slash economics

Penalty distribution is **60 / 20 / 20** — victim compensation / challenger reward / protocol. In v1 the victim and the challenger are assumed to be the same party (the buyer challenges on its own behalf), so `_slash` pays victim + challenger shares + stake refund to the challenger in one transfer; separating victim resolution is a v2 item and marked as such in the contract. False accusations cost the challenger their 1 USDC stake (forfeited to protocol on `_reject`).

Two properties make the bond an actual deterrent rather than a decoration:

- **Withdrawal is two-step.** `requestUnbond` → `UNBOND_DELAY` (1 h, demo-length) → `withdrawBond`. The bond stays challengeable for the full delay — `bondOf` is untouched until withdrawal — so "fabricate, then withdraw before anyone challenges" has a zero-length escape window: any challenge landing inside the delay locks the funds and a confirmed slash shrinks what can leave.
- **One output, one slash.** A slashed `outputHash` cannot be re-challenged (`fraudSettled`). Without this, a single fabricated output could be replayed to drain the entire bond — correct only under v1's victim == challenger assumption, and revisited when victims are separated in v2.

## What is real vs. staged — honest disclosure

- **Layer 1 — contracts and verification: real.** BondVault is deployed on Arc Testnet; every slash/reject above is an immutable on-chain transaction anyone can inspect or reproduce with `cast`.
- **Layer 2 — the demo economy: staged by the operator.** Seller, buyer, and challenger wallets are all operated by the author. Note the incentive direction: in the fraud demo **the operator slashes their own seller's bond** — the demo is adverse to its own operator.
- **Layer 3 — external participants: none yet.** No third party has posted a bond or filed a challenge. We state this rather than simulate traction.

## Known limitations (v1)

Stated here so nobody has to discover them the hard way:

- **Fixed penalty and fixed stake.** The slash penalty is a flat 10 USDC and the challenger stake a flat 1 USDC. Proportional stakes ("10% of the payment") are structurally impossible in this design, not merely unimplemented: payments ride the x402 rail entirely off-chain, so the contract never observes a payment amount. Scaling deterrence to economic weight is what the tiered-bond roadmap item is for.
- **`OFFCHAIN` defence is optimistic-only.** For source-existence and cited-value claims, any non-empty counter-evidence flips the challenge to rejection at `resolve`. v1 records the counter-evidence hash as a fixed point for off-chain re-verification by watchers; it does not adjudicate. Escalation (UMA-style) is v2. The on-chain rail for these claim types exists and is tested — what v1 lacks is teeth, and we say so.
- **Current-state attestation can misfire.** `ONCHAIN` claims check present state. A seller who genuinely supplied and then withdrew would look fabricated. This is disclosed in the contract; Merkle receipt proofs over past transactions (a-1) are the v2 fix. It is accurate for the demo class — DeFi execution where the position is supposed to persist.
- **An unreadable target counts as fabrication.** If the asserted target reverts on `staticcall` or returns nothing, the verdict is fabricated — there is no separate `Unverifiable` outcome. The stance: the provider signed the assertion, target included; signing an unreadable target is the provider's failure. A third verdict (stake returned, bond untouched) is a v2 refinement.
- **Trustlessness proves the assertion holds, not that it means anything.** `staticcall` re-execution shows the *signed predicate* is true. It cannot show the predicate references the canonical contract — a seller could assert a balance on a look-alike token they deployed themselves. Buyers (or the buyer-side SDK, roadmap) must pin asserted targets to known addresses before paying.
- **Parallel `OFFCHAIN` challenges on one output can each lock and slash within the window.** Only sequential re-slash is guarded. Under victim == challenger this over-punishes a real fraudster rather than harming honest parties; still, it is a sharp edge and v2 closes it together with victim separation.

## Roadmap (v2)

Ordered by how much they extend coverage **without** giving up the EVM-as-oracle property:

1. **Conditional escrow lane.** Prediction-type claims ("state X will hold at deadline T") resolved by the same `staticcall` predicate at T — extends Veriton from facts to time-axis claims with zero new trust assumptions. Direct answer to the "deterministic claims are a narrow slice" critique.
2. **Tiered bond rates + newcomer exposure cap.** Bond requirements ease as `rejected-challenge` count grows; new sellers face a payment cap for their first N outputs. Structural answer to bootstrap fraud (deposit big, lie once, exit).
3. **Victim / challenger separation.** Bind the buyer to `outputHash` at purchase so third-party watchers can challenge while compensation still reaches the victim.
4. **Merkle receipt proofs (a-1).** Past-transaction claims without current-state footprint.
5. **zkTLS / TLS-notary for source-existence claims.** Extends ⓐⓑ beyond optimistic defence — deliberately last, because it is the first item that imports a trust assumption (the notary) into a system whose selling point is having none.

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
