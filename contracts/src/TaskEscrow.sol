// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TaskEscrow
/// @notice Escrow contract for the MarketplaceAI agent task marketplace.
///         Requesters lock ETH when posting a task. Workers claim and submit
///         results. Requesters approve results to release funds. The protocol
///         takes a small fee on each settlement.
///
///         If the requester does not approve within `autoApproveDelay` seconds
///         after the task deadline, anyone can call autoApprove() to release
///         funds to the worker automatically.
contract TaskEscrow {
    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    enum TaskStatus {
        Open,       // funds locked, awaiting worker
        Claimed,    // worker committed to doing the task
        Submitted,  // worker submitted a result hash
        Approved,   // requester approved (or auto-approved), funds released
        Expired     // deadline passed with no submission, requester withdrew
    }

    struct Task {
        address requester;
        address worker;
        uint256 amount;      // ETH locked (wei)
        uint256 deadline;    // unix timestamp — workers must submit before this
        TaskStatus status;
        bytes32 resultHash;  // keccak256 of result, set by worker on submit
    }

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    address public owner;

    /// @dev Fee in basis points (100 = 1%). Max 1000 (10%).
    uint16 public feeBps;

    /// @dev Seconds after `task.deadline` before anyone can call autoApprove().
    uint256 public autoApproveDelay;

    /// @dev Accumulated fees not yet withdrawn.
    uint256 public pendingFees;

    mapping(bytes32 => Task) public tasks;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event TaskCreated(bytes32 indexed taskId, address indexed requester, uint256 amount, uint256 deadline);
    event TaskClaimed(bytes32 indexed taskId, address indexed worker);
    event ResultSubmitted(bytes32 indexed taskId, bytes32 resultHash);
    event ResultApproved(bytes32 indexed taskId, uint256 workerPayout, uint256 fee);
    event TaskExpired(bytes32 indexed taskId, uint256 refund);
    event FeeWithdrawn(address indexed to, uint256 amount);
    event FeeBpsUpdated(uint16 newFeeBps);
    event AutoApproveDelayUpdated(uint256 newDelay);

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error TaskAlreadyExists();
    error TaskNotFound();
    error WrongStatus(TaskStatus expected, TaskStatus actual);
    error NotRequester();
    error NotWorker();
    error NotOwner();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error AutoApproveNotReady();
    error NoValueSent();
    error FeeTooHigh();
    error TransferFailed();

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /// @param _feeBps           Protocol fee in basis points (e.g. 250 = 2.5%).
    /// @param _autoApproveDelay Seconds after deadline before auto-approval is
    ///                          allowed. E.g. 3 days = 259200.
    constructor(uint16 _feeBps, uint256 _autoApproveDelay) {
        if (_feeBps > 1000) revert FeeTooHigh();
        owner = msg.sender;
        feeBps = _feeBps;
        autoApproveDelay = _autoApproveDelay;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Requester actions
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Post a task and lock ETH as payment.
    /// @param taskId   Unique identifier (generated off-chain by the SDK).
    /// @param deadline Unix timestamp after which no new claims or submissions
    ///                 are accepted. Auto-approval window opens after
    ///                 deadline + autoApproveDelay.
    function createTask(bytes32 taskId, uint256 deadline) external payable {
        if (msg.value == 0) revert NoValueSent();
        if (tasks[taskId].requester != address(0)) revert TaskAlreadyExists();
        if (deadline <= block.timestamp) revert DeadlinePassed();

        tasks[taskId] = Task({
            requester: msg.sender,
            worker: address(0),
            amount: msg.value,
            deadline: deadline,
            status: TaskStatus.Open,
            resultHash: bytes32(0)
        });

        emit TaskCreated(taskId, msg.sender, msg.value, deadline);
    }

    /// @notice Approve the worker's result and release funds immediately.
    ///         Only the original requester can call this.
    function approveResult(bytes32 taskId) external {
        Task storage task = _getTask(taskId);
        if (msg.sender != task.requester) revert NotRequester();
        if (task.status != TaskStatus.Submitted) revert WrongStatus(TaskStatus.Submitted, task.status);

        _settle(taskId, task);
    }

    /// @notice Reclaim locked ETH after the deadline has passed.
    ///         Only allowed when no result has been submitted (Open or Claimed).
    ///         If a result was submitted, funds stay locked until approval or
    ///         auto-approval — the worker cannot be robbed by expiry.
    function expireTask(bytes32 taskId) external {
        Task storage task = _getTask(taskId);
        if (msg.sender != task.requester) revert NotRequester();
        if (block.timestamp <= task.deadline) revert DeadlineNotPassed();
        // Submitted tasks are protected — requester must use approveResult or
        // wait for autoApprove instead of expiring to avoid paying.
        if (task.status == TaskStatus.Submitted || task.status == TaskStatus.Approved) {
            revert WrongStatus(TaskStatus.Open, task.status);
        }

        uint256 refund = task.amount;
        task.status = TaskStatus.Expired;
        task.amount = 0;

        _transfer(task.requester, refund);
        emit TaskExpired(taskId, refund);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Worker actions
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Signal intent to work on a task.
    function claimTask(bytes32 taskId) external {
        Task storage task = _getTask(taskId);
        if (task.status != TaskStatus.Open) revert WrongStatus(TaskStatus.Open, task.status);
        if (block.timestamp > task.deadline) revert DeadlinePassed();

        task.status = TaskStatus.Claimed;
        task.worker = msg.sender;

        emit TaskClaimed(taskId, msg.sender);
    }

    /// @notice Submit a hash of the result. Full content is stored off-chain.
    ///         The hash lets the requester verify integrity before approving.
    /// @param resultHash keccak256 of the result text.
    function submitResult(bytes32 taskId, bytes32 resultHash) external {
        Task storage task = _getTask(taskId);
        if (msg.sender != task.worker) revert NotWorker();
        if (task.status != TaskStatus.Claimed) revert WrongStatus(TaskStatus.Claimed, task.status);
        if (block.timestamp > task.deadline) revert DeadlinePassed();

        task.status = TaskStatus.Submitted;
        task.resultHash = resultHash;

        emit ResultSubmitted(taskId, resultHash);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Permissionless: optimistic auto-approval
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Trigger automatic approval for a submitted task once the
    ///         auto-approve window has opened (deadline + autoApproveDelay).
    ///         Anyone can call this — workers are incentivised to do so.
    ///         The API also calls this via a background relayer job.
    function autoApprove(bytes32 taskId) external {
        Task storage task = _getTask(taskId);
        if (task.status != TaskStatus.Submitted) revert WrongStatus(TaskStatus.Submitted, task.status);
        if (block.timestamp <= task.deadline + autoApproveDelay) revert AutoApproveNotReady();

        _settle(taskId, task);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Owner actions
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Withdraw accumulated protocol fees.
    function withdrawFees(address to) external {
        if (msg.sender != owner) revert NotOwner();
        uint256 amount = pendingFees;
        pendingFees = 0;
        _transfer(to, amount);
        emit FeeWithdrawn(to, amount);
    }

    /// @notice Update the fee rate.
    function setFeeBps(uint16 newFeeBps) external {
        if (msg.sender != owner) revert NotOwner();
        if (newFeeBps > 1000) revert FeeTooHigh();
        feeBps = newFeeBps;
        emit FeeBpsUpdated(newFeeBps);
    }

    /// @notice Update the auto-approve delay.
    function setAutoApproveDelay(uint256 newDelay) external {
        if (msg.sender != owner) revert NotOwner();
        autoApproveDelay = newDelay;
        emit AutoApproveDelayUpdated(newDelay);
    }

    /// @notice Transfer contract ownership.
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        owner = newOwner;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View helpers
    // ─────────────────────────────────────────────────────────────────────────

    function getTask(bytes32 taskId) external view returns (Task memory) {
        return _getTask(taskId);
    }

    /// @notice Returns the unix timestamp at which autoApprove() becomes callable.
    function autoApproveAvailableAt(bytes32 taskId) external view returns (uint256) {
        return _getTask(taskId).deadline + autoApproveDelay;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _settle(bytes32 taskId, Task storage task) internal {
        task.status = TaskStatus.Approved;

        uint256 fee    = (task.amount * feeBps) / 10_000;
        uint256 payout = task.amount - fee;
        pendingFees   += fee;

        _transfer(task.worker, payout);
        emit ResultApproved(taskId, payout, fee);
    }

    function _getTask(bytes32 taskId) internal view returns (Task storage) {
        Task storage task = tasks[taskId];
        if (task.requester == address(0)) revert TaskNotFound();
        return task;
    }

    function _transfer(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
