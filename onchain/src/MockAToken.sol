// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Demo aToken. public mapping が balanceOf(address) getter を生む。
/// 本番は実 Aave aToken(同一 balanceOf インターフェース)に差し替えるだけ。
contract MockAToken {
    mapping(address => uint256) public balanceOf;
    function setBalance(address a, uint256 v) external { balanceOf[a] = v; }
}
