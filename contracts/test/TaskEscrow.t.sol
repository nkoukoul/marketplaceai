// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";

contract TaskEscrowTest is Test {
    TaskEscrow public escrow;

    address requester = makeAddr("requester");
    address worker    = makeAddr("worker");
    address owner     = makeAddr("owner");
    address anyone    = makeAddr("anyone");

    uint16  constant FEE_BPS           = 250;      // 2.5%
    uint256 constant AUTO_APPROVE_DELAY = 3 days;
    uint256 constant AMOUNT            = 1 ether;
    uint256 constant DEADLINE          = 7 days;

    bytes32 taskId     = keccak256("task-1");
    bytes32 resultHash = keccak256("the answer");

    function setUp() public {
        vm.prank(owner);
        escrow = new TaskEscrow(FEE_BPS, AUTO_APPROVE_DELAY);
        vm.deal(requester, 10 ether);
    }

    // ── Happy path ────────────────────────────────────────────────────────────

    function test_fullFlow() public {
        uint256 deadline = block.timestamp + DEADLINE;

        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, deadline);
        assertEq(uint(escrow.getTask(taskId).status), uint(TaskEscrow.TaskStatus.Open));

        vm.prank(worker);
        escrow.claimTask(taskId);
        assertEq(uint(escrow.getTask(taskId).status), uint(TaskEscrow.TaskStatus.Claimed));

        vm.prank(worker);
        escrow.submitResult(taskId, resultHash);
        assertEq(uint(escrow.getTask(taskId).status), uint(TaskEscrow.TaskStatus.Submitted));

        uint256 workerBefore = worker.balance;
        vm.prank(requester);
        escrow.approveResult(taskId);

        uint256 expectedFee    = (AMOUNT * FEE_BPS) / 10_000;
        uint256 expectedPayout = AMOUNT - expectedFee;
        assertEq(worker.balance - workerBefore, expectedPayout);
        assertEq(escrow.pendingFees(), expectedFee);
        assertEq(uint(escrow.getTask(taskId).status), uint(TaskEscrow.TaskStatus.Approved));
    }

    // ── Auto-approval ─────────────────────────────────────────────────────────

    function test_autoApprove_byAnyone() public {
        uint256 deadline = block.timestamp + DEADLINE;
        _createClaimSubmit(deadline);

        // Still too early
        vm.warp(deadline + AUTO_APPROVE_DELAY);
        vm.prank(anyone);
        vm.expectRevert(TaskEscrow.AutoApproveNotReady.selector);
        escrow.autoApprove(taskId);

        // One second after the window opens
        vm.warp(deadline + AUTO_APPROVE_DELAY + 1);

        uint256 workerBefore = worker.balance;
        vm.prank(anyone); // triggered by the API relayer, or the worker themselves
        escrow.autoApprove(taskId);

        uint256 expectedFee    = (AMOUNT * FEE_BPS) / 10_000;
        uint256 expectedPayout = AMOUNT - expectedFee;
        assertEq(worker.balance - workerBefore, expectedPayout);
        assertEq(uint(escrow.getTask(taskId).status), uint(TaskEscrow.TaskStatus.Approved));
    }

    function test_autoApproveAvailableAt() public {
        uint256 deadline = block.timestamp + DEADLINE;
        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, deadline);
        assertEq(escrow.autoApproveAvailableAt(taskId), deadline + AUTO_APPROVE_DELAY);
    }

    // ── Expire path ───────────────────────────────────────────────────────────

    function test_expireTask_openStatus() public {
        uint256 deadline = block.timestamp + 1 days;
        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, deadline);

        uint256 requesterBefore = requester.balance;
        vm.warp(deadline + 1);
        vm.prank(requester);
        escrow.expireTask(taskId);

        assertEq(requester.balance - requesterBefore, AMOUNT);
        assertEq(uint(escrow.getTask(taskId).status), uint(TaskEscrow.TaskStatus.Expired));
    }

    function test_expireTask_claimedStatus() public {
        uint256 deadline = block.timestamp + 1 days;
        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, deadline);
        vm.prank(worker);
        escrow.claimTask(taskId);

        uint256 requesterBefore = requester.balance;
        vm.warp(deadline + 1);
        vm.prank(requester);
        escrow.expireTask(taskId);

        assertEq(requester.balance - requesterBefore, AMOUNT);
    }

    function test_revert_expireTask_submittedStatus() public {
        uint256 deadline = block.timestamp + 1 days;
        _createClaimSubmit(deadline);

        vm.warp(deadline + 1);
        vm.prank(requester);
        vm.expectRevert(abi.encodeWithSelector(
            TaskEscrow.WrongStatus.selector,
            TaskEscrow.TaskStatus.Open,
            TaskEscrow.TaskStatus.Submitted
        ));
        escrow.expireTask(taskId);
    }

    // ── Fee withdrawal ────────────────────────────────────────────────────────

    function test_withdrawFees() public {
        uint256 deadline = block.timestamp + DEADLINE;
        _createClaimSubmit(deadline);
        vm.prank(requester);
        escrow.approveResult(taskId);

        address treasury   = makeAddr("treasury");
        uint256 expectedFee = (AMOUNT * FEE_BPS) / 10_000;

        vm.prank(owner);
        escrow.withdrawFees(treasury);

        assertEq(treasury.balance, expectedFee);
        assertEq(escrow.pendingFees(), 0);
    }

    // ── Owner controls ────────────────────────────────────────────────────────

    function test_setAutoApproveDelay() public {
        vm.prank(owner);
        escrow.setAutoApproveDelay(1 days);
        assertEq(escrow.autoApproveDelay(), 1 days);
    }

    // ── Revert cases ──────────────────────────────────────────────────────────

    function test_revert_onlyRequesterCanApprove() public {
        uint256 deadline = block.timestamp + DEADLINE;
        _createClaimSubmit(deadline);
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
        new TaskEscrow(1001, AUTO_APPROVE_DELAY);
    }

    function test_revert_duplicateTask() public {
        uint256 deadline = block.timestamp + 1 days;
        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, deadline);
        vm.prank(requester);
        vm.expectRevert(TaskEscrow.TaskAlreadyExists.selector);
        escrow.createTask{value: AMOUNT}(taskId, deadline);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _createClaimSubmit(uint256 deadline) internal {
        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, deadline);
        vm.prank(worker);
        escrow.claimTask(taskId);
        vm.prank(worker);
        escrow.submitResult(taskId, resultHash);
    }
}
