# Veriton onchain — BondVault

See the [root README](../README.md) for design and deployed addresses.

```
forge build
forge test -vv
```

Tests cover both verdicts: `test_Fraud_Slash` (fabricated claim → slash, 60/20/20 payout) and `test_Honest_Reject` (true claim → challenge rejected, stake forfeited).
