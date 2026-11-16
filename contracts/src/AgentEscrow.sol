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
///      The client can reject a delivery it is not satisfied with, but only while the
///      grace period is still running: the escrow reopens and the agent may deliver
///      again before the deadline. Without this, an agent could submit an empty proof
///      and be paid after the grace period even if the work is worthless. After the
///      grace period the agent's claim right is unconditional, so a client cannot
///      front-run a claim with a last-second rejection.
///
///      Task ids must be unguessable (the app generates random 32-byte ids). Anyone
///      who knows a task id can read it, but only the recorded client/agent can move it.
///      Unlike the kit's Checkout (anyone can pay any order any amount), every escrow
///      transition checks the caller, the amount and the state.
///
///      The recorded amount is what the contract actually received, not what the
///      client asked to lock: if the token takes a fee on transfer, the escrow
///      records the net amount, so a release can never revert for insufficient
///      balance and no funds can get stuck that way.
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
    event DeliveryRejected(bytes32 indexed taskId, address indexed client);
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
    error GracePassed();

    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    /// @notice Lock `amount` of tUSD8 for `agent` to complete `taskId` before `deadline`.
    /// The caller must have approved this contract for `amount` first.
    /// @dev Records the amount actually received, so fee-on-transfer tokens cannot
    ///      leave the escrow promising more than it holds.
    function createEscrow(bytes32 taskId, address agent, uint256 amount, uint64 deadline) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (agent == address(0)) revert ZeroAddress();
        if (_escrows[taskId].status != Status.None) revert AlreadyExists(taskId);
        if (deadline <= block.timestamp) revert DeadlinePassed();
        uint256 balanceBefore = token.balanceOf(address(this));
        _escrows[taskId] = Escrow({
            client: msg.sender,
            agent: agent,
            amount: amount,
            deadline: deadline,
            deliveredAt: 0,
            proof: bytes32(0),
            status: Status.Created
        });
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert ZeroAmount();
        if (received != amount) _escrows[taskId].amount = received;
        emit EscrowCreated(taskId, msg.sender, agent, received, deadline);
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

    /// @notice The client rejects a delivery it is not satisfied with. Only possible
    /// while the grace period is still running: the escrow reopens (status back to
    /// Created, proof cleared) so the agent may deliver again before the deadline.
    /// After the deadline the client can refund instead. Once the grace period has
    /// passed the agent's claim right is unconditional and rejection is closed.
    function rejectDelivery(bytes32 taskId) external {
        Escrow storage e = _escrows[taskId];
        if (e.status == Status.None) revert NotFound(taskId);
        if (msg.sender != e.client) revert NotClient();
        if (e.status != Status.Delivered) revert WrongStatus(taskId, e.status);
        if (block.timestamp > e.deliveredAt + GRACE_PERIOD) revert GracePassed();
        e.status = Status.Created;
        e.deliveredAt = 0;
        e.proof = bytes32(0);
        emit DeliveryRejected(taskId, msg.sender);
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
