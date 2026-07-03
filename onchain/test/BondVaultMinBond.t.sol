// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {BondVault} from "../src/BondVault.sol";
import {BondVaultTest} from "./BondVault.t.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// penalty(10 USDC 固定)と bond の境界挙動を固定するテスト群。
/// 事実の固定が目的:
///   (1) free bond < penalty の provider は challenge 自体を開けない
///       = sub-penalty bond は「参入障壁」ではなく「slash 不能な飾り」になる(README Limitations に記載)。
///   (2) challenge 開設は penalty をフルロックする
///       = bond 10 USDC の provider に同時に開ける challenge は 1 件のみ
///       (並行 OFFCHAIN challenge によるドレインは free bond の総量で頭打ちになる)。
contract BondVaultMinBondTest is BondVaultTest {
    uint256 constant PENALTY = 10e6; // _penaltyFor の現行固定値と対応

    // ───────────── ヘルパ:任意 pk の provider で claim を作る ─────────────

    function _buildClaimFor(uint256 pk, uint256 expected)
        internal view
        returns (bytes memory evidence, bytes32 outputHash, bytes memory sig)
    {
        address who = vm.addr(pk);
        bytes memory callData = abi.encodeWithSignature("balanceOf(address)", who);
        evidence   = abi.encode(address(aToken), callData, BondVault.Op.GTE, expected);
        outputHash = keccak256(evidence);
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(outputHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethHash);
        sig = abi.encodePacked(r, s, v);
    }

    function _newProviderWithBond(uint256 pk, uint256 bond) internal returns (address who) {
        who = vm.addr(pk);
        usdc.mint(who, bond);
        vm.startPrank(who);
        usdc.approve(address(vault), type(uint256).max);
        vault.depositBond(bond);
        vm.stopPrank();
    }

    // ───────────── (1) sub-penalty bond は challenge 不能 ─────────────

    /// bond 5 USDC(< penalty)の provider が捏造しても、challenge は入口で revert する。
    /// slash が「失敗」するのではなく、そもそも申立を開けない点が要旨。
    function test_SubPenaltyBond_IsUnchallengeable() public {
        uint256 pk = 0xB0B;
        address microProvider = _newProviderWithBond(pk, 5e6);
        (bytes memory evidence, bytes32 outputHash, bytes memory sig) = _buildClaimFor(pk, 50e6);
        // aToken 残高 0 のまま = 捏造。だが free bond 5 < penalty 10。

        vm.prank(challenger);
        vm.expectRevert("insufficient free bond");
        vault.challenge(microProvider, outputHash, sig, BondVault.ClaimType.ONCHAIN, evidence);

        // bond は無傷のまま残る = 経済的には「bonded に見えて slash 不能」
        assertEq(vault.bondOf(microProvider), 5e6, "sub-penalty bond remains untouched");
    }

    /// 境界値:bond がちょうど penalty(10 USDC)なら challenge は成立し、捏造なら満額 slash。
    function test_ExactPenaltyBond_ChallengeSucceeds() public {
        uint256 pk = 0xB0B2;
        address edgeProvider = _newProviderWithBond(pk, PENALTY);
        (bytes memory evidence, bytes32 outputHash, bytes memory sig) = _buildClaimFor(pk, 50e6);

        vm.prank(challenger);
        vault.challenge(edgeProvider, outputHash, sig, BondVault.ClaimType.ONCHAIN, evidence);

        assertEq(vault.bondOf(edgeProvider), 0, "exact-penalty bond fully slashed");
        assertEq(vault.lockedOf(edgeProvider), 0, "lock released after slash");
    }

    // ───────────── (2) ロックによる並行 challenge の頭打ち ─────────────

    /// bond 10 USDC の provider に OFFCHAIN challenge を 1 件開くと penalty がフルロックされ、
    /// 2 件目(別 outputHash)は free bond 不足で開けない。
    /// = 並行 challenge でのドレインは free bond / penalty 件までしか同時進行できない。
    function test_LockGate_SecondParallelChallengeReverts() public {
        uint256 pk = 0xB0B3;
        address p = _newProviderWithBond(pk, PENALTY);
        (bytes memory ev1, bytes32 hash1, bytes memory sig1) = _buildClaimFor(pk, 50e6);
        (bytes memory ev2, bytes32 hash2, bytes memory sig2) = _buildClaimFor(pk, 60e6); // 別 assertion = 別 outputHash

        vm.prank(challenger);
        vault.challenge(p, hash1, sig1, BondVault.ClaimType.OFFCHAIN, ev1);
        assertEq(vault.lockedOf(p), PENALTY, "first challenge locks full penalty");

        // 2 件目の stake 原資を補充して申立 → free = 10 - 10 = 0 で revert
        usdc.mint(challenger, 1e6);
        vm.prank(challenger);
        vm.expectRevert("insufficient free bond");
        vault.challenge(p, hash2, sig2, BondVault.ClaimType.OFFCHAIN, ev2);
    }

    /// 対照:bond 20 USDC なら 2 件まで同時に開ける(ロック上限が bond 総量で決まることの確認)。
    function test_LockGate_TwoChallengesWithDoubleBond() public {
        uint256 pk = 0xB0B4;
        address p = _newProviderWithBond(pk, PENALTY * 2);
        (bytes memory ev1, bytes32 hash1, bytes memory sig1) = _buildClaimFor(pk, 50e6);
        (bytes memory ev2, bytes32 hash2, bytes memory sig2) = _buildClaimFor(pk, 60e6);

        usdc.mint(challenger, 2e6);
        vm.startPrank(challenger);
        vault.challenge(p, hash1, sig1, BondVault.ClaimType.OFFCHAIN, ev1);
        vault.challenge(p, hash2, sig2, BondVault.ClaimType.OFFCHAIN, ev2);
        vm.stopPrank();

        assertEq(vault.lockedOf(p), PENALTY * 2, "both penalties locked");
    }
}
