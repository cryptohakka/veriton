// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {BondVault} from "../src/BondVault.sol";
import {BondVaultTest} from "./BondVault.t.sol";

/// P1(2段階引出)/ P2(1出力1罰)のテスト群。
/// BondVaultTest を継承し setUp / _buildClaim を再利用する。
contract BondVaultUnbondTest is BondVaultTest {
    // ───────────── P1: unbonding delay ─────────────

    /// 予約なしの直接引出は不可(旧・即時 withdraw の廃止を担保)。
    function test_Withdraw_WithoutRequest_Reverts() public {
        vm.prank(provider);
        vm.expectRevert("exceeds unbonding");
        vault.withdrawBond(10e6);
    }

    /// 予約後でも delay 経過前は引出不可。
    function test_Withdraw_BeforeDelay_Reverts() public {
        vm.startPrank(provider);
        vault.requestUnbond(10e6);
        vm.expectRevert("unbond delay not elapsed");
        vault.withdrawBond(10e6);
        vm.stopPrank();
    }

    /// 予約 → delay 経過 → 引出成功。
    function test_Withdraw_AfterDelay_Succeeds() public {
        vm.startPrank(provider);
        vault.requestUnbond(10e6);
        vm.warp(block.timestamp + vault.UNBOND_DELAY());
        uint256 before = usdc.balanceOf(provider);
        vault.withdrawBond(10e6);
        vm.stopPrank();

        assertEq(vault.bondOf(provider), 90e6, "bond should decrease");
        assertEq(usdc.balanceOf(provider), before + 10e6, "provider should receive funds");
        assertEq(vault.unbondingOf(provider), 0, "reservation should be consumed");
    }

    /// 攻撃シナリオ本体:捏造 → 即 requestUnbond で逃走を試みる。
    /// delay 窓内に challenge が着弾 → slash は成立し、引出は slash 後残高に切り詰められる。
    function test_FraudThenUnbond_ChallengeStillSlashes() public {
        (bytes memory evidence, bytes32 outputHash, bytes memory sig) = _buildClaim(50e6);
        // aToken 残高 0 のまま = 捏造

        // provider が全額引出を予約(逃走の試み)
        vm.prank(provider);
        vault.requestUnbond(100e6);

        // delay 窓内に challenger が着弾 → 即 slash(bondOf は無傷だったので lock 可能)
        vm.prank(challenger);
        vault.challenge(provider, outputHash, sig, BondVault.ClaimType.ONCHAIN, evidence);
        assertEq(vault.bondOf(provider), 90e6, "slash must land despite pending unbond");

        // delay 経過後、予約 100e6 のうち引き出せるのは slash 後の free = 90e6 まで
        vm.warp(block.timestamp + vault.UNBOND_DELAY());
        vm.startPrank(provider);
        vm.expectRevert("exceeds free bond");
        vault.withdrawBond(100e6);
        vault.withdrawBond(90e6);   // 残額は引出可(誠実な残余資産の没収はしない)
        vm.stopPrank();
        assertEq(vault.bondOf(provider), 0, "remaining bond withdrawn");
    }

    // ───────────── P2: 1出力1罰 ─────────────

    /// slash 確定済みの outputHash への再 challenge は入口で弾かれる。
    /// これが無いと 1 つの捏造で bond 全額をドレインできてしまう。
    function test_Rechallenge_AfterSlash_Reverts() public {
        (bytes memory evidence, bytes32 outputHash, bytes memory sig) = _buildClaim(50e6);

        vm.prank(challenger);
        vault.challenge(provider, outputHash, sig, BondVault.ClaimType.ONCHAIN, evidence);
        assertEq(vault.bondOf(provider), 90e6, "first slash lands");

        // 2発目の stake 原資を補充して再申立 → 入口 revert
        usdc.mint(challenger, 1e6);
        vm.prank(challenger);
        vm.expectRevert("output already slashed");
        vault.challenge(provider, outputHash, sig, BondVault.ClaimType.ONCHAIN, evidence);

        assertEq(vault.bondOf(provider), 90e6, "no double slash");
    }
}
