import { parseAbi, type Address } from "viem";

/** tUSD8 on Aevum testnet: a USDC-style token (FiatTokenV2) with 6 decimals, EIP-2612 and EIP-3009. */
export const TUSD8_ADDRESS: Address = "0x456569838f1d43009A91ebA4263147Afd7233483";
export const TUSD8_DECIMALS = 6;

/** EIP-712 domain of tUSD8. MockUSD8 (local) uses the same name and version. */
export function tusd8Domain(chainId: number, verifyingContract: Address) {
  return { name: "tUSD8", version: "2", chainId, verifyingContract } as const;
}

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const eip3009Abi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

/** ABI of contracts/src/Checkout.sol. */
export const checkoutAbi = parseAbi([
  "function token() view returns (address)",
  "function merchant() view returns (address)",
  "function pay(bytes32 orderId, uint256 amount)",
  "function payWithAuthorization(bytes32 orderId, address from, uint256 amount, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationNonce(bytes32 orderId) view returns (bytes32)",
  "function isPaid(bytes32 orderId) view returns (bool)",
  "function paymentOf(bytes32 orderId) view returns ((address payer, uint64 paidAt, uint256 amount))",
  "event Paid(bytes32 indexed orderId, address indexed payer, uint256 amount)",
  "error AlreadyPaid(bytes32 orderId)",
  "error ZeroAmount()",
  "error ZeroAddress()",
]);

/** AgentEscrow deployed on Aevum testnet (chain 44005) for the Builder Challenge. */
export const AGENT_ESCROW_AEVUM_ADDRESS: Address = "0x655a895477fBb38fB4A7c279cad04A4e218F284b";

/** Block the AgentEscrow deploy transaction landed in (used as the event-scan start). */
export const AGENT_ESCROW_AEVUM_DEPLOY_BLOCK = 3302809n;

/** ABI of contracts/src/AgentEscrow.sol. */
export const agentEscrowAbi = parseAbi([
  "function token() view returns (address)",
  "function GRACE_PERIOD() view returns (uint64)",
  "function createEscrow(bytes32 taskId, address agent, uint256 amount, uint64 deadline)",
  "function markDelivered(bytes32 taskId, bytes32 proof)",
  "function confirmRelease(bytes32 taskId)",
  "function refund(bytes32 taskId)",
  "function claimUnconfirmed(bytes32 taskId)",
  "function escrowOf(bytes32 taskId) view returns ((address client, address agent, uint256 amount, uint64 deadline, uint64 deliveredAt, bytes32 proof, uint8 status))",
  "event EscrowCreated(bytes32 indexed taskId, address indexed client, address indexed agent, uint256 amount, uint64 deadline)",
  "event Delivered(bytes32 indexed taskId, address indexed agent, bytes32 proof)",
  "event Released(bytes32 indexed taskId, address indexed agent, uint256 amount)",
  "event Refunded(bytes32 indexed taskId, address indexed client, uint256 amount)",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error AlreadyExists(bytes32 taskId)",
  "error NotClient()",
  "error NotAgent()",
  "error NotFound(bytes32 taskId)",
  "error WrongStatus(bytes32 taskId, uint8 status)",
  "error DeadlinePassed()",
  "error DeadlineNotPassed()",
  "error GraceNotPassed()",
]);
