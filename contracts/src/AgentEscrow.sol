// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AgentEscrow
/// @notice Trust-minimised escrow for AI-agent work, paid in tUSD8 on QDay Aevum testnet.
/// @dev A client locks tUSD8 for a task. The agent submits a delivery proof, the client
///      confirms, and the funds release to the agent. If the deadline passes with no
///      delivery, the client reclaims the funds. If the agent delivers but the client
///      never confirms, the agent can claim after a grace period, so a silent client
///      cannot grief the agent forever.
///
///      Task ids must be unguessable (the app generates random 32-byte ids). Anyone
///      who knows a task id can read it, but only the recorded client/agent can move it.
///      Unlike the kit's Checkout (anyone can pay any order any amount), every escrow
///      transition checks the caller, the amount and the state.
contract AgentEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Created,
        Delivered,
        Released,
        Refunded
    }

    struct Escrow {
        address client;
        address agent;
        uint256 amount;
        uint64 deadline;
        uint64 deliveredAt;
        bytes32 proof;
        Status status;
    }

    /// @notice Grace period after delivery during which only the client can release.
    /// After it passes, the agent may claim the funds themselves.
    uint64 public constant GRACE_PERIOD = 1 days;

    IERC20 public immutable token;

    mapping(bytes32 taskId => Escrow) private _escrows;

    event EscrowCreated(
        bytes32 indexed taskId, address indexed client, address indexed agent, uint256 amount, uint64 deadline
    );
    event Delivered(bytes32 indexed taskId, address indexed agent, bytes32 proof);
    event Released(bytes32 indexed taskId, address indexed agent, uint256 amount);
    event Refunded(bytes32 indexed taskId, address indexed client, uint256 amount);

    error ZeroAmount();
    error ZeroAddress();
    error AlreadyExists(bytes32 taskId);
    error NotClient();
    error NotAgent();
    error NotFound(bytes32 taskId);
    error WrongStatus(bytes32 taskId, Status status);
    error DeadlinePassed();
    error DeadlineNotPassed();
    error GraceNotPassed();

    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    /// @notice Lock `amount` of tUSD8 for `agent` to complete `taskId` before `deadline`.
    /// The caller must have approved this contract for `amount` first.
    function createEscrow(bytes32 taskId, address agent, uint256 amount, uint64 deadline) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (agent == address(0)) revert ZeroAddress();
        if (_escrows[taskId].status != Status.None) revert AlreadyExists(taskId);
        if (deadline <= block.timestamp) revert DeadlinePassed();
        _escrows[taskId] = Escrow({
            client: msg.sender,
            agent: agent,
            amount: amount,
            deadline: deadline,
            deliveredAt: 0,
            proof: bytes32(0),
            status: Status.Created
        });
        emit EscrowCreated(taskId, msg.sender, agent, amount, deadline);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice The agent submits delivery, attaching a proof hash (e.g. hash of the work artifact).
    function markDelivered(bytes32 taskId, bytes32 proof) external {
        Escrow storage e = _escrows[taskId];
        if (e.status == Status.None) revert NotFound(taskId);
        if (msg.sender != e.agent) revert NotAgent();
        if (e.status != Status.Created) revert WrongStatus(taskId, e.status);
        if (block.timestamp > e.deadline) revert DeadlinePassed();
        e.status = Status.Delivered;
        e.deliveredAt = uint64(block.timestamp);
        e.proof = proof;
        emit Delivered(taskId, msg.sender, proof);
    }

    /// @notice The client confirms delivery; the locked funds go to the agent.
    function confirmRelease(bytes32 taskId) external nonReentrant {
        Escrow storage e = _escrows[taskId];
        if (e.status == Status.None) revert NotFound(taskId);
        if (msg.sender != e.client) revert NotClient();
        if (e.status != Status.Delivered) revert WrongStatus(taskId, e.status);
        e.status = Status.Released;
        emit Released(taskId, e.agent, e.amount);
        token.safeTransfer(e.agent, e.amount);
    }

    /// @notice After the deadline passes with no delivery, the client reclaims the funds.
    function refund(bytes32 taskId) external nonReentrant {
        Escrow storage e = _escrows[taskId];
        if (e.status == Status.None) revert NotFound(taskId);
        if (msg.sender != e.client) revert NotClient();
        if (e.status != Status.Created) revert WrongStatus(taskId, e.status);
        if (block.timestamp <= e.deadline) revert DeadlineNotPassed();
        e.status = Status.Refunded;
        emit Refunded(taskId, e.client, e.amount);
        token.safeTransfer(e.client, e.amount);
    }

    /// @notice If the agent delivered but the client never confirms, the agent can claim
    /// after the grace period. Prevents a silent client from locking funds forever.
    function claimUnconfirmed(bytes32 taskId) external nonReentrant {
        Escrow storage e = _escrows[taskId];
        if (e.status == Status.None) revert NotFound(taskId);
        if (msg.sender != e.agent) revert NotAgent();
        if (e.status != Status.Delivered) revert WrongStatus(taskId, e.status);
        if (block.timestamp <= e.deliveredAt + GRACE_PERIOD) revert GraceNotPassed();
        e.status = Status.Released;
        emit Released(taskId, e.agent, e.amount);
        token.safeTransfer(e.agent, e.amount);
    }

    function escrowOf(bytes32 taskId) external view returns (Escrow memory) {
        return _escrows[taskId];
    }
}
