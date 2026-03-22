// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";

contract Deploy is Script {
    /// @dev 2.5% protocol fee.
    uint16 constant FEE_BPS = 250;

    /// @dev Auto-approve window: 3 days after the task deadline.
    ///      Workers are guaranteed payment if the requester ghosts for 3 days.
    uint256 constant AUTO_APPROVE_DELAY = 3 days;

    /// @dev Claim timeout: 7 days after claimedAt.
    ///      If a worker doesn't submit within 7 days of claiming, anyone can
    ///      call releaseStaleClaimTask() to reopen the task.
    uint256 constant CLAIM_TIMEOUT = 7 days;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        TaskEscrow escrow = new TaskEscrow(FEE_BPS, AUTO_APPROVE_DELAY, CLAIM_TIMEOUT);
        console.log("TaskEscrow deployed at:  ", address(escrow));
        console.log("Owner:                   ", escrow.owner());
        console.log("Fee bps:                 ", escrow.feeBps());
        console.log("Auto-approve delay (s):  ", escrow.autoApproveDelay());
        console.log("Claim timeout (s):       ", escrow.claimTimeout());

        vm.stopBroadcast();
    }
}
