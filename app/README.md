# Veriton app — seller + agent

Based on Circle's [arc-nanopayments-demo](https://github.com/akelani-circle/arc-nanopayments-demo); Circle-origin files keep their Apache-2.0 headers and are unmodified. See the [root README](../README.md) for what Veriton is.

Veriton additions:

- `lib/verified-gateway.ts` — `withVerifiedGateway`: wraps a paid handler so every response carries a signed, on-chain-challengeable assertion
- `app/api/premium/defi-execute/` — demo endpoint: paid DeFi execution attestation (honest → challenge fails, lying → bond slashed)
- `gen-envelope.mts` — canonical envelope generator, plain Node (no Next.js): `npx tsx gen-envelope.mts <wallet> <aToken> [amount]`

Supabase from the upstream demo is not required for the Veriton flow (the dashboard degrades gracefully without it).
