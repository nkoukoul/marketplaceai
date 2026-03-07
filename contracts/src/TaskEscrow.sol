// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TaskEscrow
/// @notice Escrow contract for the MarketplaceAI agent task marketplace.
///         Requesters lock ETH when posting a task. Workers claim and submit
///         results. Requesters approve results to release funds. The protocol
///         takes a small fee on each settlement.
contract TaskEscrow {
    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    enum TaskStatus {
        Open,       // funds locked, awaiting worker
        Claimed,    // worker committed to doing the task
        Submitted,  // worker submitted a result hash
        Approved,   // requester approved, funds released
        Expired     // deadline passed, requester withdrew
    }

    struct Task {
        address requester;
        address worker;
        uint256 amount;      // ETH locked (wei)
        uint256 deadline;    // unix timestamp
        TaskStatus status;
        bytes32 resultHash;  // keccak256 of result, set by worker
    }

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    address public owner;

    /// @dev Fee in basis points (100 = 1%). Max 1000 (10%).
    uint16 public feeBps;

    /// @dev Accumulated fees not yet withdrawn
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
    error NoValueSent();
    error FeeTooHigh();
    error TransferFailed();

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    constructor(uint16 _feeBps) {
        if (_feeBps > 1000) revert FeeTooHigh();
        owner = msg.sender;
        feeBps = _feeBps;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Requester actions
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Post a task and lock ETH as payment.
    /// @param taskId   Unique identifier (generated off-chain by the API).
    /// @param deadline Unix timestamp after which the task expires.
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

    /// @notice Approve the worker's result and release funds.
    ///         Only the original requester can call this.
    function approveResult(bytes32 taskId) external {
        Task storage task = _getTask(taskId);
        if (msg.sender != task.requester) revert NotRequester();
        if (task.status != TaskStatus.Submitted) revert WrongStatus(TaskStatus.Submitted, task.status);

        task.status = TaskStatus.Approved;

        uint256 fee = (task.amount * feeBps) / 10_000;
        uint256 payout = task.amount - fee;
        pendingFees += fee;

        _transfer(task.worker, payout);
        emit ResultApproved(taskId, payout, fee);
    }

    /// @notice Reclaim locked ETH after the deadline has passed.
    ///         Only callable if the task was never approved.
    function expireTask(bytes32 taskId) external {
        Task storage task = _getTask(taskId);
        if (msg.sender != task.requester) revert NotRequester();
        if (block.timestamp <= task.deadline) revert DeadlineNotPassed();
        if (task.status == TaskStatus.Approved) revert WrongStatus(TaskStatus.Open, task.status);

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

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

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
