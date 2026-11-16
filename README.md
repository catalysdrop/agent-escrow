# AgentEscrow — trust-minimised escrow for agent work

Pay an AI agent for a job **without trusting it**: a client locks tUSD8 in escrow, the
agent marks the work delivered with a proof hash, and the payment is released only
when the client confirms — or automatically to the agent if the client goes silent.
If the deadline passes with nothing delivered, the client gets a full refund.

Built for the **Aevum Builder Challenge #1** (QDay / DoraHacks) on **QDay Aevum
testnet** (chain `44005`), using **tUSD8**. Track: **Decentralized Payments /
Native AI Assistants**. Solo entry by [x24aiai](https://dorahacks.io/builder/x24aiai)
(0x24aiai).

> Judging counts activity on Aevum. All contracts, payments and escrows here happen
> on Aevum testnet. Nothing settles on another chain.

## Live deployment

| | |
|---|---|
| AgentEscrow | [`0x54e833291455D68e944D178FBbbF3F7Ebb359046`](https://explorer-test.qday.info/address/0x54e833291455D68e944D178FBbbF3F7Ebb359046) |
| Deploy tx | [`0x4d3d03351b8d3c1997da558c6fa89571cd9f3485b2890f381832082e7afd6b9c`](https://explorer-test.qday.info/tx/0x4d3d03351b8d3c1997da558c6fa89571cd9f3485b2890f381832082e7afd6b9c) |
| Deploy block | `3308598` |
| Deploy cost | `0.000969` tQDAY |
| tUSD8 | [`0x456569838f1d43009A91ebA4263147Afd7233483`](https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483), 6 decimals |
| Deployer (testnet-only wallet) | `0x58d56263dbe9c20aafb48adef1c21d66a13619aa` |
| Deployed | 16 Nov 2026, after the hackathon kickoff (Build Fresh) |
| Source at deploy | commit `926dcfb` (`Audit fixes: rejectDelivery dispute path, net-received accounting, UI hardening`) |

v1 (`0x655a…284b`, block `3302809`) was superseded by this v2 redeploy after a
pre-submit security audit found one Medium (no dispute path for a bad
delivery). The v1 demo escrow (0.5 tUSD8) stays locked in v1 until its
deadline, when the client can refund it.

Contract verification on the explorer isn't available yet, so the exact commit above
is the source of truth — see [Submitting](#submitting).

## How it works

```
client ── approve(AgentEscrow, amount) ──▶ tUSD8
client ── createEscrow(taskId, agent, amount, deadline) ──▶ AgentEscrow (locks funds)
agent  ── markDelivered(taskId, proofHash) ──▶ AgentEscrow  (before deadline)
client ── confirmRelease(taskId) ──▶ AgentEscrow ──▶ agent gets paid
   ...or, if the client goes silent:
agent  ── claimUnconfirmed(taskId) ──▶ AgentEscrow ──▶ agent gets paid (after deliveredAt + 1 day grace)
   ...or, if the delivery is not good enough (within the 1-day grace period):
client ── rejectDelivery(taskId) ──▶ AgentEscrow ──▶ escrow reopens, agent may deliver again
   ...or, if nothing was delivered in time:
client ── refund(taskId) ──▶ AgentEscrow ──▶ client gets a full refund
```

States: `Created → Delivered → Released`, or `Created → Refunded`. Every
transition emits an event (`EscrowCreated`, `Delivered`, `Released`, `Refunded`).

Rules enforced on-chain, per escrow:

- Only the recorded **client** can create, confirm, or refund; only the recorded
  **agent** can mark delivered or claim. Anyone else reverts.
- Amounts are exact: the escrow holds exactly what was locked, and release/refund
  move exactly that amount — no "pay any order any amount" hole (the starter
  kit's `Checkout` allows anyone to pay any order with any amount; AgentEscrow
  closes that by keying every action to the task's client/agent/state).
- `markDelivered` only before the deadline; `refund` only while `Created` and
  past the deadline; `claimUnconfirmed` only while `Delivered` and past
  `deliveredAt + GRACE_PERIOD` (1 day) — so a silent client can't stall the
  agent forever, and an agent can't claim before the client had a fair window
  to confirm or dispute.
- `rejectDelivery` (client-only, while `Delivered` and inside the grace
  period) reopens the escrow so the agent can deliver again before the
  deadline. Without it, an agent could submit an empty proof and be paid
  after the grace period even if the work is worthless. After the grace
  period the agent's claim right is unconditional, so a client cannot
  front-run a claim with a last-second rejection.
- The recorded amount is what the contract actually received, not what the
  client asked to lock — a fee-on-transfer token can never leave the escrow
  promising more than it holds.
- `taskId` is a random 32 bytes generated client-side; sequential ids could be
  claimed in advance. A task id can be used only once (`AlreadyExists`).
- `ReentrancyGuard` + `SafeERC20` on all fund movements; the UI approves the
  exact escrow amount, never unlimited.

The delivery **proof** is a `bytes32` hash (the UI hashes the delivery text with
`keccak256`). The contract stores the hash, not the text — the full delivery
lives off-chain (e.g. a link, a repo commit, a file hash). The task description
shown in the UI is kept in the browser's local storage only; the chain holds
the money, the parties, the amounts, the deadline, and the proof hash.

## Web app

Next.js app (wagmi + RainbowKit) with an **Escrow** page (`/escrow`):

- **Create escrow:** agent address, amount in tUSD8, deadline in days,
  task description. Two wallet steps: approve exact amount, then create.
- **Escrow list:** read from `EscrowCreated` events (chunked, from deploy block
  `3308598`) with live state via `escrowOf`, auto-refresh every 30 s.
- **Role actions:** only the buttons your wallet is allowed to use appear —
  agent marks delivered (proof text → hash), client confirms or refunds,
  agent claims after the grace period (button shows a countdown until then).
- Every step shows its transaction hash with an explorer link, and errors are
  translated from the contract's custom errors into plain language.

The kit's original pages (setup checker, checkout, receipts, activity) are
kept intact as a reference implementation.

## Quickstart

You need [Node 22+](https://nodejs.org), [pnpm](https://pnpm.io/installation)
and [Foundry](https://book.getfoundry.sh/getting-started/installation) (`foundryup`).

```bash
git clone https://github.com/catalysdrop/agent-escrow.git
cd agent-escrow
make install          # Solidity libs + JS packages
make check            # build, Shanghai opcode check, unit tests, fork tests
```

### Contracts

```bash
make test             # 29/29 green: 18 AgentEscrow + 11 Checkout (kit)
make build            # compile + Shanghai opcode check
```

Deploy AgentEscrow (needs a funded testnet keystore — see below):

```bash
make deploy-escrow-aevum ACCOUNT=aevum-deployer   # Aevum testnet, real tUSD8
make deploy-escrow-fork                            # local fork of Aevum
make deploy-escrow-local                           # empty local chain + MockUSD8
```

### Web app

```bash
cp web/.env.example web/.env.local
#   NEXT_PUBLIC_NETWORKS=aevum
#   NEXT_PUBLIC_ESCROW_AEVUM=0x54e833291455D68e944D178FBbbF3F7Ebb359046
#   NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM=3308598
make dev              # http://localhost:3000
```

Get test tokens: join the [QDay Discord](https://discord.gg/bYPhjmrSfK),
react ✅ in `#verify`, then `/faucet <your address>` — 1 tQDAY + 5 tUSD8,
once per Discord account and once per address. Or https://faucet.qday.info.

**Live demo:** https://agent-escrow.netlify.app (Netlify, deployed
16 Nov 2026, public). **Deploying the web app yourself:** on Netlify, import the repo,
set **Base directory** to `web`, **Build command** `pnpm build`, **Node**
`22`, and add `NEXT_PUBLIC_NETWORKS=aevum`,
`NEXT_PUBLIC_ESCROW_AEVUM=<address>`,
`NEXT_PUBLIC_DEPLOY_BLOCK_AEVUM=3308598`, and optionally
`NEXT_PUBLIC_WC_PROJECT_ID` (WalletConnect, free at
[cloud.reown.com](https://cloud.reown.com)). Keep the whole repo connected
(not just `web/`): the app imports `packages/aevum` through the pnpm workspace.
(The same works on Vercel with **Root Directory** `web` instead.)

## Network details

| | |
|---|---|
| Network | QDay Aevum Testnet |
| Chain ID | `44005` |
| RPC | `https://rpc-test.qday.info` (HTTPS only, no WebSocket) |
| Explorer | https://explorer-test.qday.info |
| Gas token | tQDAY (18 decimals), about 1 gwei |
| EVM version | **Shanghai** |
| tUSD8 | `0x456569838f1d43009A91ebA4263147Afd7233483`, 6 decimals, USDC-style (EIP-2612 `permit`, EIP-3009 signed transfers) |

All of this is in [`packages/aevum/src/chain.ts`](packages/aevum/src/chain.ts)
and [`contracts.ts`](packages/aevum/src/contracts.ts).

## Things that differ from Ethereum

| | What happens | What to do |
|---|---|---|
| **Shanghai EVM** | Cancun opcodes (`MCOPY`, `TSTORE`/`TLOAD`, blob ops) don't exist. Code compiled for Cancun deploys fine, then reverts with `invalid opcode`. | Keep `evm_version = "shanghai"` in `foundry.toml` (already set). `make build` runs [`tools/check-shanghai.mjs`](tools/check-shanghai.mjs) to catch it. |
| **1,000-block log limit** | `eth_getLogs` over more than 1,000 blocks fails. | Use `getLogsChunked` from `@aevum-kit/aevum`. The Escrow page starts from the deploy block. |
| **No WebSocket RPC** | `watchContractEvent` over WS won't connect. | Poll over HTTPS (viem's default for `http()` transports). |
| **Explorer verification** | Not working yet. | Link the exact commit + address in the README and submission. |
| **Legacy transactions** | The kit's scripts send legacy (type 0) transactions, the same as QDay's own faucet. | `--legacy` in `forge script`, `type: "legacy"` in viem. |

## Project layout

```
contracts/            Foundry project
  src/AgentEscrow.sol   the escrow contract (this project)
  src/Checkout.sol      kit example contract (kept as reference)
  src/mocks/MockUSD8.sol  local tUSD8 stand-in (anyone can mint)
  test/AgentEscrow.t.sol  18 unit tests for AgentEscrow
  test/                 kit tests (11)
  script/DeployAgentEscrow.s.sol  deploys AgentEscrow
packages/aevum/       chain config, ABIs (incl. AgentEscrow), getLogsChunked
web/                  Next.js app (wagmi + RainbowKit)
  src/app/escrow/       create escrow, list, role actions (this project)
  src/app/page.tsx        Setup check
  src/app/checkout/       standard + gasless checkout (kit)
  src/app/receipts/       receipt read from the chain
  src/app/activity/       events, read in 1,000-block chunks
  src/app/api/relay/      gasless relayer (server-side, kit)
examples/             runnable TypeScript scripts (kit)
tools/check-shanghai.mjs  fails the build on Cancun-only opcodes
LICENSE, NOTICE.md     MIT license and third-party licenses
```

## Commands

```
make install        Fetch Solidity libs and JS packages
make build          Compile contracts and check they are Shanghai-safe
make test           Unit tests (local, no network)
make test-fork      Tests against the real tUSD8 on a local fork of Aevum
make check          Build, tests and typecheck (CI also runs pnpm build)
make anvil          Empty local chain (31337) with Aevum's EVM rules
make fork           Local copy of Aevum testnet on 127.0.0.1:8555 (chain 440050)
make deploy-escrow-local   Deploy AgentEscrow to `make anvil`
make deploy-escrow-fork    Deploy AgentEscrow (real tUSD8) to `make fork`
make deploy-escrow-aevum   Deploy AgentEscrow to Aevum testnet (ACCOUNT=<keystore>)
make deploy-local   Deploy MockUSD8 + Checkout to `make anvil` (kit)
make deploy-fork    Deploy Checkout (real tUSD8) to `make fork` (kit)
make deploy-aevum   Deploy Checkout to Aevum testnet (kit)
make dev            Start the web app on http://localhost:3000
```

Keep your deployer key out of files and shell history. Foundry's encrypted
keystore asks for the key once and a password each time:

```bash
cast wallet import aevum-deployer --interactive   # paste the key of a TEST wallet
cast wallet address --account aevum-deployer      # fund this address from the faucet
```

> Use a wallet made only for testing. Never paste a private key into chat, an
> issue, or a committed file. The deployer here holds testnet tokens only.

## Submitting

- Contract on Aevum testnet (`44005`) with explorer links: see
  [Live deployment](#live-deployment).
- Exact commit deployed: `926dcfb` (contract v2) — the frontend is `eecda3e`.
- Demo: live URL https://agent-escrow.netlify.app + **2–3 minute demo video** (required at submit).
  Video: [AgentEscrow demo (2:04, Unlisted)](https://www.youtube.com/watch?v=V9U1uRjav_k) — recorded 16 Nov 2026, narrated slideshow of the live v2 demo.

## Build Fresh

All code and deployments in this repo are from **after the kickoff message
(16 Nov 2026, 14:00 WITA)** — judges can check the GitHub commit log and the
on-chain deploy timestamp:

- `e13915f` — base on Aevum Starter Kit (MIT, PQA Labs)
- `6463f73` — AgentEscrow contract + 18 tests, deployed same day
- `d8b1bb3` — Escrow frontend

## Licenses and credit

Based on the **Aevum Starter Kit** (MIT, © 2026 PQA Labs) — its `LICENSE` file
and `NOTICE.md` are kept, and the kit's code is credited in the commit history.
This project itself is MIT licensed, see [LICENSE](LICENSE). Third-party
licenses are listed in [NOTICE.md](NOTICE.md).

---

MIT licensed. Questions: [QDay Discord](https://discord.gg/bYPhjmrSfK) Builder
Challenge channels (verify first to see them), Mon–Fri 10:00–18:00 HKT.
