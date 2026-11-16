// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentEscrow} from "../src/AgentEscrow.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";

contract AgentEscrowTest is Test {
    AgentEscrow internal escrow;
    MockUSD8 internal token;

    address internal client = makeAddr("client");
    address internal agent = makeAddr("agent");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant TASK = keccak256("task-1");
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

    function testCreateEscrowLocksFunds() public {
        uint64 deadline = _create();
        assertEq(token.balanceOf(client), 1_000e6 - AMOUNT);
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
        AgentEscrow.Escrow memory e = escrow.escrowOf(TASK);
        assertEq(e.client, client);
        assertEq(e.agent, agent);
        assertEq(e.amount, AMOUNT);
        assertEq(e.deadline, deadline);
        assertEq(uint8(e.status), uint8(AgentEscrow.Status.Created));
    }

    function testHappyPathRelease() public {
        _create();
        vm.prank(agent);
        escrow.markDelivered(TASK, PROOF);
        vm.prank(client);
        escrow.confirmRelease(TASK);
        assertEq(token.balanceOf(agent), AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.escrowOf(TASK).status), uint8(AgentEscrow.Status.Released));
        assertEq(escrow.escrowOf(TASK).proof, PROOF);
    }

    function testRefundAfterDeadline() public {
        uint64 deadline = _create();
        vm.warp(deadline + 1);
        vm.prank(client);
        escrow.refund(TASK);
        assertEq(token.balanceOf(client), 1_000e6);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.escrowOf(TASK).status), uint8(AgentEscrow.Status.Refunded));
    }

    function testClaimAfterGraceWhenClientSilent() public {
        _create();
        vm.prank(agent);
        escrow.markDelivered(TASK, PROOF);
        vm.warp(block.timestamp + escrow.GRACE_PERIOD() + 1);
        vm.prank(agent);
        escrow.claimUnconfirmed(TASK);
        assertEq(token.balanceOf(agent), AMOUNT);
        assertEq(uint8(escrow.escrowOf(TASK).status), uint8(AgentEscrow.Status.Released));
    }

    function testRevertCreateZeroAmount() public {
        vm.prank(client);
        vm.expectRevert(AgentEscrow.ZeroAmount.selector);
        escrow.createEscrow(TASK, agent, 0, uint64(block.timestamp + 1 days));
    }

    function testRevertCreateZeroAgent() public {
        vm.prank(client);
        vm.expectRevert(AgentEscrow.ZeroAddress.selector);
        escrow.createEscrow(TASK, address(0), AMOUNT, uint64(block.timestamp + 1 days));
    }

    function testRevertCreateDuplicateTask() public {
        _create();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentEscrow.AlreadyExists.selector, TASK));
        escrow.createEscrow(TASK, agent, AMOUNT, uint64(block.timestamp + 1 days));
    }

    function testRevertCreatePastDeadline() public {
        vm.prank(client);
        vm.expectRevert(AgentEscrow.DeadlinePassed.selector);
        escrow.createEscrow(TASK, agent, AMOUNT, uint64(block.timestamp));
    }

    function testRevertDeliverByNonAgent() public {
        _create();
        vm.prank(stranger);
        vm.expectRevert(AgentEscrow.NotAgent.selector);
        escrow.markDelivered(TASK, PROOF);
    }

    function testRevertDeliverTwice() public {
        _create();
        vm.prank(agent);
        escrow.markDelivered(TASK, PROOF);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentEscrow.WrongStatus.selector, TASK, AgentEscrow.Status.Delivered
            )
        );
        escrow.markDelivered(TASK, PROOF);
    }

    function testRevertDeliverAfterDeadline() public {
        uint64 deadline = _create();
        vm.warp(deadline + 1);
        vm.prank(agent);
        vm.expectRevert(AgentEscrow.DeadlinePassed.selector);
        escrow.markDelivered(TASK, PROOF);
    }

    function testRevertConfirmByNonClient() public {
        _create();
        vm.prank(agent);
        escrow.markDelivered(TASK, PROOF);
        vm.prank(stranger);
        vm.expectRevert(AgentEscrow.NotClient.selector);
        escrow.confirmRelease(TASK);
    }

    function testRevertConfirmBeforeDelivery() public {
        _create();
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(AgentEscrow.WrongStatus.selector, TASK, AgentEscrow.Status.Created)
        );
        escrow.confirmRelease(TASK);
    }

    function testRevertRefundBeforeDeadline() public {
        _create();
        vm.prank(client);
        vm.expectRevert(AgentEscrow.DeadlineNotPassed.selector);
        escrow.refund(TASK);
    }

    function testRevertRefundAfterDelivery() public {
        uint64 deadline = _create();
        vm.prank(agent);
        escrow.markDelivered(TASK, PROOF);
        vm.warp(deadline + 1);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentEscrow.WrongStatus.selector, TASK, AgentEscrow.Status.Delivered
            )
        );
        escrow.refund(TASK);
    }

    function testRevertClaimBeforeGrace() public {
        _create();
        vm.prank(agent);
        escrow.markDelivered(TASK, PROOF);
        vm.prank(agent);
        vm.expectRevert(AgentEscrow.GraceNotPassed.selector);
        escrow.claimUnconfirmed(TASK);
    }

    function testRevertDoubleRelease() public {
        _create();
        vm.prank(agent);
        escrow.markDelivered(TASK, PROOF);
        vm.prank(client);
        escrow.confirmRelease(TASK);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(AgentEscrow.WrongStatus.selector, TASK, AgentEscrow.Status.Released)
        );
        escrow.confirmRelease(TASK);
    }

    function testRevertUnknownTask() public {
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentEscrow.NotFound.selector, TASK));
        escrow.confirmRelease(TASK);
    }
}
