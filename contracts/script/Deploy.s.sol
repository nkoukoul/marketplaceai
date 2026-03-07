// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";

contract Deploy is Script {
    /// @dev Fee: 250 bps = 2.5%. Change before mainnet if desired.
    uint16 constant FEE_BPS = 250;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        TaskEscrow escrow = new TaskEscrow(FEE_BPS);
        console.log("TaskEscrow deployed at:", address(escrow));
        console.log("Owner:", escrow.owner());
        console.log("Fee bps:", escrow.feeBps());

        vm.stopBroadcast();
    }
}
