// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AgentEscrow} from "../src/AgentEscrow.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";

/// @notice Audit tests (16 Nov 2026). Local only, no fork, no live funds.
/// @dev Covers the two contract findings from the security audit:
///      F-1 (Medium) no dispute path for a bad delivery, and
///      F-2 (Low) recorded amount vs actually-received amount on fee tokens.

/// Minimal ERC20 that takes a 1% fee on every transfer (fee goes to a collector).
contract FeeToken is ERC20 {
    uint256 public constant FEE_BPS = 100; // 1%
    address public constant feeCollector = address(0x00000000000000000000000000000000000000fe);

    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 0) {
            uint256 fee = (value * FEE_BPS) / 10_000;
            super._update(from, to, value - fee);
            if (fee > 0) super._update(from, feeCollector, fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// ERC20 that takes a 100% fee on every transfer (everything goes to a collector).
contract FullFeeToken is ERC20 {
    address public constant feeCollector = address(0x00000000000000000000000000000000000000ff);

    constructor() ERC20("Full Fee Token", "FFEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 0) {
            super._update(from, feeCollector, value);
        } else {
            super._update(from, to, value);
        }
    }
}

contract AgentEscrowAuditTest is Test {
    AgentEscrow internal escrow;
    MockUSD8 internal token;

    address internal client = makeAddr("client");
    address internal agent = makeAddr("agent");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant TASK = keccak256("audit-task-1");
    uint256 internal constant AMOUNT = 100e6; // 100 tUSD8 (6 decimals)
    bytes32 internal constant PROOF = keccak256("delivery-artifact");

    function setUp() public {
        token = new MockUSD8();
        escrow = new AgentEscrow(token);
        token.mint(client, 1_000e6);
        vm.prank(client);
        token.approve(address(escrow), type(uint256).max);
    }

    function _create() internal returns (uint64 deadline) {
        deadline = uint64(block.timestamp + 7 days);
        vm.prank(client);
        escrow.createEscrow(TASK, agent, AMOUNT, deadline);
    }

    // ---- F-1: no dispute path (PoC of the original behaviour) ----

    /// The original design lets an agent submit an EMPTY proof and still be paid
    /// in full if the client never acts: after the grace period the agent claims.
    /// This test documents that residual behaviour. The fix (rejectDelivery)
    /// only helps a client who actively rejects inside the grace window.
    function test_knownLimitation_emptyProofPaysIfClientNeverActs() public {
        _create();
        vm.prank(agent);
        escrow.markDelivered(TASK, bytes32(0)); // empty proof
        vm.warp(block.timestamp + escrow.GRACE_PERIOD() + 1);
        vm.prank(agent);
        escrow.claimUnconfirmed(TASK);
        assertEq(token.balanceOf(agent), AMOUNT);
        assertEq(uint8(escrow.escrowOf(TASK).status), uint8(AgentEscrow.Status.Released));
    }

    // ---- F-1 fix: rejectDelivery ----

    function testRejectDeliveryReopensEscrow() public {
        _create();
        vm.prank(agent);
        escrow.markDelivered(TASK, bytes32(0)); // garbage delivery
        vm.prank(client);
        escrow.rejectDelivery(TASK);
        AgentEscrow.Escrow memory e = escrow.escrowOf(TASK);
        assertEq(uint8(e.status), uint8(AgentEscrow.Status.Created));
        assertEq(e.deliveredAt, 0);
        assertEq(e.proof, bytes32(0));
        assertEq(token.balanceOf(address(escrow)), AMOUNT); // funds stay locked
    }

    function testRejectThenRedeliverAndConfirm() public {
        _create();
        vm.prank(agent);
        escrow.markDelivered(TASK, bytes32(0));
        vm.prank(client);
        escrow.rejectDelivery(TASK);
        vm.prank(agent);
        escrow.markDelivered(TASK, PROOF); // real delivery, second try
        vm.prank(client);
        escrow.confirmRelease(TASK);
        assertEq(token.balanceOf(agent), AMOUNT);
        assertEq(uint8(escrow.escrowOf(TASK).status), uint8(AgentEscrow.Status.Released));
    }

    function testRejectThenDeadlineRefund() public {
        uint64 deadline = _create();
        vm.prank(agent);
        escrow.markDelivered(TASK, bytes32(0));
        vm.prank(client);
        escrow.rejectDelivery(TASK);
        vm.warp(deadline + 1);
        vm.prank(client);
        escrow.refund(TASK);
        assertEq(token.balanceOf(client), 1_000e6);
        assertEq(uint8(escrow.escrowOf(TASK).status), uint8(AgentEscrow.Status.Refunded));
    }

    function testRevertRejectByNonClient() public {
        _create();
        vm.prank(agent);
        escrow.markDelivered(TASK, PROOF);
        vm.prank(stranger);
        vm.expectRevert(AgentEscrow.NotClient.selector);
        escrow.rejectDelivery(TASK);
    }

    function testRevertRejectWhenNotDelivered() public {
        _create();
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(AgentEscrow.WrongStatus.selector, TASK, AgentEscrow.Status.Created)
        );
        escrow.rejectDelivery(TASK);
    }

    function testRevertRejectAfterGrace() public {
        _create();
        vm.prank(agent);
        escrow.markDelivered(TASK, PROOF);
        vm.warp(block.timestamp + escrow.GRACE_PERIOD() + 1);
        vm.prank(client);
        vm.expectRevert(AgentEscrow.GracePassed.selector);
        escrow.rejectDelivery(TASK);
        // Agent's claim right is intact after the failed rejection.
        vm.prank(agent);
        escrow.claimUnconfirmed(TASK);
        assertEq(token.balanceOf(agent), AMOUNT);
    }

    function testRevertRejectTwice() public {
        _create();
        vm.prank(agent);
        escrow.markDelivered(TASK, PROOF);
        vm.prank(client);
        escrow.rejectDelivery(TASK);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(AgentEscrow.WrongStatus.selector, TASK, AgentEscrow.Status.Created)
        );
        escrow.rejectDelivery(TASK);
    }

    // ---- F-2: fee-on-transfer accounting ----

    /// With a 1% fee token the escrow records the NET received amount (99),
    /// so release pays exactly what the contract holds and nothing gets stuck.
    function testFeeTokenRecordsNetReceived() public {
        FeeToken fee = new FeeToken();
        AgentEscrow feeEscrow = new AgentEscrow(fee);
        fee.mint(client, 1_000e6);
        vm.prank(client);
        fee.approve(address(feeEscrow), type(uint256).max);
        bytes32 task = keccak256("fee-task");
        vm.prank(client);
        feeEscrow.createEscrow(task, agent, AMOUNT, uint64(block.timestamp + 7 days));
        AgentEscrow.Escrow memory e = feeEscrow.escrowOf(task);
        assertEq(e.amount, 99e6); // 100 - 1% fee
        assertEq(fee.balanceOf(address(feeEscrow)), 99e6);
        vm.prank(agent);
        feeEscrow.markDelivered(task, PROOF);
        vm.prank(client);
        feeEscrow.confirmRelease(task);
        // The release itself pays the recorded 99e6, and the token takes its
        // 1% fee again on the way out: 99e6 * 0.99 = 98_010_000 to the agent.
        // The contract holds exactly 0 afterwards — nothing is stuck.
        assertEq(fee.balanceOf(agent), 98_010_000);
        assertEq(fee.balanceOf(address(feeEscrow)), 0);
    }

    /// A token that takes a 100% fee locks nothing: the contract receives 0,
    /// so creation reverts instead of recording an escrow it cannot pay out.
    function testFeeTokenFullFeeReverts() public {
        FullFeeToken full = new FullFeeToken();
        AgentEscrow fullEscrow = new AgentEscrow(full);
        full.mint(client, 1_000e6);
        vm.prank(client);
        full.approve(address(fullEscrow), type(uint256).max);
        vm.prank(client);
        vm.expectRevert(AgentEscrow.ZeroAmount.selector);
        fullEscrow.createEscrow(keccak256("full-fee-task"), agent, AMOUNT, uint64(block.timestamp + 7 days));
    }
}
