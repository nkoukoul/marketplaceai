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
    uint256 constant CLAIM_TIMEOUT     = 7 days;
    uint256 constant AMOUNT            = 1 ether;
    uint256 constant DEADLINE          = 7 days;

    bytes32 taskId     = keccak256("task-1");
    bytes32 resultHash = keccak256("the answer");

    function setUp() public {
        vm.prank(owner);
        escrow = new TaskEscrow(FEE_BPS, AUTO_APPROVE_DELAY, CLAIM_TIMEOUT);
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
        assertEq(escrow.getTask(taskId).claimedAt, block.timestamp);

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

    // ── Release claim ─────────────────────────────────────────────────────────

    function test_releaseClaim_byRequester() public {
        uint256 deadline = block.timestamp + DEADLINE;
        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, deadline);

        vm.prank(worker);
        escrow.claimTask(taskId);
        assertEq(uint(escrow.getTask(taskId).status), uint(TaskEscrow.TaskStatus.Claimed));

        vm.prank(requester);
        vm.expectEmit(true, true, false, false);
        emit TaskEscrow.TaskReleased(taskId, requester);
        escrow.releaseClaim(taskId);

        TaskEscrow.Task memory t = escrow.getTask(taskId);
        assertEq(uint(t.status), uint(TaskEscrow.TaskStatus.Open));
        assertEq(t.worker, address(0));
        assertEq(t.claimedAt, 0);
    }

    function test_releaseClaim_workerCanReclaimAfterRelease() public {
        uint256 deadline = block.timestamp + DEADLINE;
        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, deadline);

        vm.prank(worker);
        escrow.claimTask(taskId);

        vm.prank(requester);
        escrow.releaseClaim(taskId);

        // A different worker can now claim
        address worker2 = makeAddr("worker2");
        vm.prank(worker2);
        escrow.claimTask(taskId);
        assertEq(escrow.getTask(taskId).worker, worker2);
    }

    function test_revert_releaseClaim_notRequester() public {
        uint256 deadline = block.timestamp + DEADLINE;
        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, deadline);

        vm.prank(worker);
        escrow.claimTask(taskId);

        vm.prank(worker);
        vm.expectRevert(TaskEscrow.NotRequester.selector);
        escrow.releaseClaim(taskId);
    }

    function test_revert_releaseClaim_wrongStatus() public {
        uint256 deadline = block.timestamp + DEADLINE;
        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, deadline);

        // Task is Open, not Claimed
        vm.prank(requester);
        vm.expectRevert(abi.encodeWithSelector(
            TaskEscrow.WrongStatus.selector,
            TaskEscrow.TaskStatus.Claimed,
            TaskEscrow.TaskStatus.Open
        ));
        escrow.releaseClaim(taskId);
    }

    // ── Stale claim release ───────────────────────────────────────────────────

    function test_releaseStaleClaimTask_byAnyone() public {
        uint256 deadline = block.timestamp + DEADLINE;
        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, deadline);

        uint256 claimedAt = block.timestamp;
        vm.prank(worker);
        escrow.claimTask(taskId);

        // Still within timeout (one second before expiry)
        vm.warp(claimedAt + CLAIM_TIMEOUT - 1);
        vm.prank(anyone);
        vm.expectRevert(TaskEscrow.ClaimNotExpired.selector);
        escrow.releaseStaleClaimTask(taskId);

        // Exactly at timeout — allowed
        vm.warp(claimedAt + CLAIM_TIMEOUT);
        vm.prank(anyone);
        vm.expectEmit(true, true, false, false);
        emit TaskEscrow.TaskReleased(taskId, anyone);
        escrow.releaseStaleClaimTask(taskId);

        TaskEscrow.Task memory t = escrow.getTask(taskId);
        assertEq(uint(t.status), uint(TaskEscrow.TaskStatus.Open));
        assertEq(t.worker, address(0));
        assertEq(t.claimedAt, 0);
    }

    function test_revert_releaseStaleClaimTask_wrongStatus() public {
        uint256 deadline = block.timestamp + DEADLINE;
        vm.prank(requester);
        escrow.createTask{value: AMOUNT}(taskId, deadline);

        // Task is Open, not Claimed
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(
            TaskEscrow.WrongStatus.selector,
            TaskEscrow.TaskStatus.Claimed,
            TaskEscrow.TaskStatus.Open
        ));
        escrow.releaseStaleClaimTask(taskId);
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

    function test_setClaimTimeout() public {
        vm.prank(owner);
        escrow.setClaimTimeout(14 days);
        assertEq(escrow.claimTimeout(), 14 days);
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
        new TaskEscrow(1001, AUTO_APPROVE_DELAY, CLAIM_TIMEOUT);
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
