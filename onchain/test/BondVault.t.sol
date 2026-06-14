// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {BondVault} from "../src/BondVault.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// 最小 USDC モック(allowance 検証あり)。
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt; return true;
    }
    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt; balanceOf[to] += amt; return true;
    }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt; balanceOf[to] += amt; return true;
    }
}

/// Aave aToken モック。public mapping が balanceOf(address) getter を生む。
contract MockAToken {
    mapping(address => uint256) public balanceOf;
    function setBalance(address a, uint256 v) external { balanceOf[a] = v; }
}

contract BondVaultTest is Test {
    BondVault vault;
    MockUSDC  usdc;
    MockAToken aToken;

    uint256 providerPk = 0xA11CE;
    address provider;
    address challenger = address(0xBEEF);
    address protocol   = address(0xC0FFEE);

    function setUp() public {
        provider = vm.addr(providerPk);
        usdc   = new MockUSDC();
        aToken = new MockAToken();
        vault  = new BondVault(address(usdc), protocol);

        // provider: 資金 + bond 100 USDC 供託
        usdc.mint(provider, 1000e6);
        vm.startPrank(provider);
        usdc.approve(address(vault), type(uint256).max);
        vault.depositBond(100e6);
        vm.stopPrank();

        // challenger: 資金 10 USDC + approve
        usdc.mint(challenger, 10e6);
        vm.prank(challenger);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// provider が署名する assertion = 「aToken.balanceOf(provider) >= expected」。
    /// outputHash = keccak256(evidence) に束縛 → challenger は改竄できない。
    function _buildClaim(uint256 expected)
        internal view
        returns (bytes memory evidence, bytes32 outputHash, bytes memory sig)
    {
        bytes memory callData = abi.encodeWithSignature("balanceOf(address)", provider);
        evidence   = abi.encode(address(aToken), callData, BondVault.Op.GTE, expected);
        outputHash = keccak256(evidence);
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(outputHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(providerPk, ethHash);
        sig = abi.encodePacked(r, s, v);
    }

    /// 嘘:供給したと主張するが aToken 残高ゼロ → 即 slash。
    function test_Fraud_Slash() public {
        (bytes memory evidence, bytes32 outputHash, bytes memory sig) = _buildClaim(50e6);
        // aToken 残高は 0 のまま(=嘘)

        vm.prank(challenger);
        vault.challenge(provider, outputHash, sig, BondVault.ClaimType.ONCHAIN, evidence);

        assertEq(vault.bondOf(provider),   90e6, "bond should be slashed by penalty");
        assertEq(vault.lockedOf(provider),  0,   "lock should be released");
        // challenger: 6(補填)+2(報酬)+1(stake返却)=9 受領 → 9(残)+9=18
        assertEq(usdc.balanceOf(challenger), 18e6, "challenger payout wrong");
        assertEq(usdc.balanceOf(protocol),   2e6,  "protocol cut wrong");
    }

    /// 正直:本当に供給済み(残高 >= expected)→ 虚偽申立として _reject。
    function test_Honest_Reject() public {
        (bytes memory evidence, bytes32 outputHash, bytes memory sig) = _buildClaim(50e6);
        aToken.setBalance(provider, 50e6); // 痕跡あり

        vm.prank(challenger);
        vault.challenge(provider, outputHash, sig, BondVault.ClaimType.ONCHAIN, evidence);

        assertEq(vault.bondOf(provider),   100e6, "bond must stay intact");
        assertEq(vault.lockedOf(provider),  0,    "lock should be released");
        assertEq(usdc.balanceOf(challenger), 9e6, "challenger should forfeit stake");
        assertEq(usdc.balanceOf(protocol),   1e6, "protocol should keep forfeited stake");
    }
}
