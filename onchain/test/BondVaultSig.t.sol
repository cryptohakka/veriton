// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {BondVault} from "../src/BondVault.sol";
import {BondVaultTest} from "./BondVault.t.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// _verifySig の負テスト群。BondVaultTest を継承し setUp / _buildClaim を再利用する。
contract BondVaultSigTest is BondVaultTest {
    /// 他人の鍵で署名された envelope は challenge 段階で弾かれる。
    function test_BadSig_Reverts() public {
        (bytes memory evidence, bytes32 outputHash, ) = _buildClaim(50e6);
        // 攻撃者の鍵で署名を偽造
        uint256 attackerPk = 0xBAD;
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(outputHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attackerPk, ethHash);
        bytes memory badSig = abi.encodePacked(r, s, v);

        vm.prank(challenger);
        vm.expectRevert("bad signature");
        vault.challenge(provider, outputHash, badSig, BondVault.ClaimType.ONCHAIN, evidence);
    }

    /// 壊れた署名(長さ不正)は tryRecover が false に倒し、同じく revert。
    function test_MalformedSig_Reverts() public {
        (bytes memory evidence, bytes32 outputHash, ) = _buildClaim(50e6);
        bytes memory garbage = hex"deadbeef";

        vm.prank(challenger);
        vm.expectRevert("bad signature");
        vault.challenge(provider, outputHash, garbage, BondVault.ClaimType.ONCHAIN, evidence);
    }
}
