// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal mock ERC-20 with mint, burn, and a blocklist that reverts transfers.
contract MockERC20 is ERC20 {
    uint8 private _dec;
    mapping(address => bool) public blocklisted;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function setBlocklisted(address a, bool v) external {
        blocklisted[a] = v;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (blocklisted[from] || blocklisted[to]) revert("BLOCKED");
        super._update(from, to, amount);
    }
}
