// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";

contract TaskEscrowTest is Test {
    TaskEscrow public escrow;

    address requester = makeAddr("requester");
    address worker    = makeAddr("worker");
    address owner     = makeAddr("owner");

    uint16  constant FEE_BPS  = 250; // 2.5%
    uint256 constant AMOUNT   = 1 ether;
    uint256 constant DEADLINE = 7 days;

    bytes32 taskId     = keccak256("task-1");
    bytes32 resultHash = keccak256("the answer");

    function setUp() public {
        vm.prank(owner);
        escrow = new TaskEscrow(FEE_BPS);

        vm.deal(requester, 10 ether);
    }

    // ── Happy path ────────────────────────────────────────────────────────────

    function test_fullFlow() public {
        uint256 deadline = block.timestamp + DEADLINE;

        // 1. Create task
        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, deadline);

        assertEq(uint(escrow.getTask(taskId).status), uint(TaskEscrow.TaskStatus.Open));

        // 2. Claim
        vm.prank(worker);
        escrow.claimTask(taskId);
        assertEq(uint(escrow.getTask(taskId).status), uint(TaskEscrow.TaskStatus.Claimed));

        // 3. Submit result
        vm.prank(worker);
        escrow.submitResult(taskId, resultHash);
        assertEq(uint(escrow.getTask(taskId).status), uint(TaskEscrow.TaskStatus.Submitted));

        // 4. Approve
        uint256 workerBefore = worker.balance;
        vm.prank(requester);
        escrow.approveResult(taskId);

        uint256 expectedFee    = (AMOUNT * FEE_BPS) / 10_000;
        uint256 expectedPayout = AMOUNT - expectedFee;

        assertEq(worker.balance - workerBefore, expectedPayout);
        assertEq(escrow.pendingFees(), expectedFee);
        assertEq(uint(escrow.getTask(taskId).status), uint(TaskEscrow.TaskStatus.Approved));
    }

    // ── Fee withdrawal ────────────────────────────────────────────────────────

    function test_withdrawFees() public {
        _createClaimSubmitApprove();

        address feeRecipient = makeAddr("treasury");
        uint256 expectedFee  = (AMOUNT * FEE_BPS) / 10_000;

        vm.prank(owner);
        escrow.withdrawFees(feeRecipient);

        assertEq(feeRecipient.balance, expectedFee);
        assertEq(escrow.pendingFees(), 0);
    }

    // ── Expire path ───────────────────────────────────────────────────────────

    function test_expireTask() public {
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, deadline);

        uint256 requesterBefore = requester.balance;

        vm.warp(deadline + 1);
        vm.prank(requester);
        escrow.expireTask(taskId);

        assertEq(requester.balance - requesterBefore, AMOUNT);
    }

    // ── Revert cases ──────────────────────────────────────────────────────────

    function test_revert_onlyRequesterCanApprove() public {
        _createClaimSubmit();

        vm.prank(worker);
        vm.expectRevert(TaskEscrow.NotRequester.selector);
        escrow.approveResult(taskId);
    }

    function test_revert_cannotClaimAfterDeadline() public {
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, deadline);

        vm.warp(deadline + 1);
        vm.prank(worker);
        vm.expectRevert(TaskEscrow.DeadlinePassed.selector);
        escrow.claimTask(taskId);
    }

    function test_revert_feeTooHigh() public {
        vm.expectRevert(TaskEscrow.FeeTooHigh.selector);
        new TaskEscrow(1001);
    }

    function test_revert_duplicateTask() public {
        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, block.timestamp + 1 days);

        vm.prank(requester);
        vm.expectRevert(TaskEscrow.TaskAlreadyExists.selector);
        escrow.createTask{value: AMOUNT}(taskId, block.timestamp + 1 days);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _createClaimSubmit() internal {
        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, block.timestamp + DEADLINE);
        vm.prank(worker);
        escrow.claimTask(taskId);
        vm.prank(worker);
        escrow.submitResult(taskId, resultHash);
    }

    function _createClaimSubmitApprove() internal {
        _createClaimSubmit();
        vm.prank(requester);
        escrow.approveResult(taskId);
    }
}
