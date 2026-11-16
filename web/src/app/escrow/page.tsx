"use client";

import {
  AGENT_ESCROW_AEVUM_DEPLOY_BLOCK,
  agentEscrowAbi,
  erc20Abi,
  getLogsChunked,
  txUrl,
} from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  formatUnits,
  getAbiItem,
  isAddress,
  keccak256,
  parseUnits,
  toHex,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import { useAccount, useConfig, usePublicClient, useReadContract } from "wagmi";
import {
  readContract,
  readContracts,
  simulateContract,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";
import { useToken } from "@/components/useToken";
import { useNetwork } from "@/lib/network";
import { explain } from "@/lib/errors";
import { orderLabel, short } from "@/lib/order";

const STATUS_LABELS = ["None", "Created", "Delivered", "Released", "Refunded"] as const;

interface EscrowState {
  client: Address;
  agent: Address;
  amount: bigint;
  deadline: bigint;
  deliveredAt: bigint;
  proof: Hex;
  status: number;
}

interface EscrowView extends EscrowState {
  taskId: Hex;
  blockNumber: bigint;
  txHash: Hash;
  description: string | null;
}

type Phase = "idle" | "working" | "done" | "error";

const CREATE_STEPS = [
  { title: "Approve tUSD8", who: "approve(AgentEscrow, exact amount) · you pay gas" },
  { title: "Create escrow", who: "AgentEscrow.createEscrow(...) · you pay gas" },
  { title: "Confirmed on Aevum", who: "The EscrowCreated event is your receipt" },
];

const DESC_KEY = "aevum-kit:escrow-descriptions";

/** Task descriptions live only in this browser (the contract stores no text). */
function loadDescriptions(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DESC_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function saveDescription(taskId: string, desc: string) {
  try {
    const all = loadDescriptions();
    all[taskId] = desc;
    localStorage.setItem(DESC_KEY, JSON.stringify(all));
  } catch {
    // Storage can be blocked. The escrow still exists on chain; only its label is lost.
  }
}

function countdown(targetSeconds: bigint, nowSeconds: number): string {
  const diff = Number(targetSeconds) - nowSeconds;
  if (diff <= 0) return "expired";
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

function formatDate(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function EscrowPage() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const escrowAddress = net.escrow;
  const hasExplorer = net.hasExplorer;
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;
  const token = useToken();
  const client = usePublicClient({ chainId: appChain.id }) as PublicClient | undefined;

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);

  // ---- Create form ----
  const [agentInput, setAgentInput] = useState("");
  const [amountInput, setAmountInput] = useState("10");
  const [daysInput, setDaysInput] = useState("7");
  const [descInput, setDescInput] = useState("");
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txApprove, setTxApprove] = useState<Hash | null>(null);
  const [txCreate, setTxCreate] = useState<Hash | null>(null);
  const [createdTaskId, setCreatedTaskId] = useState<Hex | null>(null);
  const [descVersion, setDescVersion] = useState(0);

  const balance = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: appChain.id,
    query: { enabled: onChain && Boolean(token.address) },
  });

  let parsedAmount: bigint | null = null;
  try {
    parsedAmount = amountInput.trim() ? parseUnits(amountInput.trim(), token.decimals) : null;
  } catch {
    parsedAmount = null;
  }
  const enoughBalance = balance.data === undefined || parsedAmount === null || balance.data >= parsedAmount;
  const busy = phase === "working";

  function resetForm() {
    setStep(0);
    setPhase("idle");
    setError(null);
    setTxApprove(null);
    setTxCreate(null);
    setCreatedTaskId(null);
  }

  async function onCreate() {
    if (phase === "done") {
      resetForm();
      return;
    }
    if (!address || !escrowAddress || !token.address) return;
    const agentAddr = agentInput.trim();
    if (!isAddress(agentAddr)) {
      setError("Enter a valid agent wallet address (0x…).");
      return;
    }
    if (agentAddr.toLowerCase() === address.toLowerCase()) {
      setError("The agent can't be your own address — escrowing to yourself locks funds for nothing.");
      return;
    }
    if (parsedAmount === null || parsedAmount <= 0n) {
      setError("Enter a valid amount greater than zero.");
      return;
    }
    const days = Number(daysInput);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      setError("Deadline must be between 1 and 365 days from now.");
      return;
    }
    // A fresh random id every time: task ids must be unguessable so nobody can
    // front-run or squat a task before the client funds it.
    const taskId = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + Math.floor(days * 86400));
    const amount = parsedAmount;
    setError(null);
    setPhase("working");
    setStep(0);
    setTxApprove(null);
    setTxCreate(null);
    setCreatedTaskId(null);
    try {
      // 1. Approve exactly the escrow amount, never an unlimited amount.
      const allowance = await readContract(config, {
        address: token.address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, escrowAddress],
        chainId: appChain.id,
      });
      if (allowance < amount) {
        const { request } = await simulateContract(config, {
          account: address,
          address: token.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [escrowAddress, amount],
          chainId: appChain.id,
        });
        const hash = await writeContract(config, request);
        setTxApprove(hash);
        const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
        if (receipt.status !== "success") throw new Error("The approval reverted on chain.");
      }
      // 2. Create the escrow. Simulate first: a revert shows up here with its
      // reason, before the wallet asks for gas.
      setStep(1);
      const { request } = await simulateContract(config, {
        account: address,
        address: escrowAddress,
        abi: agentEscrowAbi,
        functionName: "createEscrow",
        args: [taskId, agentAddr as Address, amount, deadline],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      setTxCreate(hash);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("The escrow creation reverted on chain.");
      setStep(2);
      setCreatedTaskId(taskId);
      if (descInput.trim()) saveDescription(taskId, descInput.trim());
      setDescVersion((v) => v + 1);
      setPhase("done");
      void escrowsQuery.refetch();
      balance.refetch();
    } catch (e) {
      setError(explain(e));
      setPhase("error");
    }
  }

  // ---- Escrow list ----
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  const escrowsQuery = useQuery({
    queryKey: ["escrows", appChain.id, escrowAddress, descVersion],
    enabled: Boolean(client && escrowAddress),
    refetchInterval: 30_000,
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      // Scan from the deploy block when we know it; otherwise the last 20k blocks.
      const from =
        net.deployBlock ??
        (appChain.id === 44005 ? AGENT_ESCROW_AEVUM_DEPLOY_BLOCK : head > 20_000n ? head - 20_000n + 1n : 0n);
      const logs = await getLogsChunked(client!, {
        address: escrowAddress!,
        event: getAbiItem({ abi: agentEscrowAbi, name: "EscrowCreated" }),
        fromBlock: from,
        toBlock: head,
      });
      const ordered = [...logs].reverse();
      const taskIds = ordered.map((l) => l.args.taskId as Hex);
      const grace =
        taskIds.length > 0
          ? await readContract(config, {
              address: escrowAddress!,
              abi: agentEscrowAbi,
              functionName: "GRACE_PERIOD",
              chainId: appChain.id,
            })
          : 0n;
      const states =
        taskIds.length > 0
          ? await readContracts(config, {
              contracts: taskIds.map((taskId) => ({
                address: escrowAddress!,
                abi: agentEscrowAbi,
                functionName: "escrowOf",
                args: [taskId],
                chainId: appChain.id,
              })),
            })
          : [];
      const descriptions = loadDescriptions();
      // Chain time (from the head block) gates the action buttons: a skewed
      // local clock must not hide Refund/Deliver/Claim. Falls back to local
      // time if the block header can't be read.
      let chainNow: bigint | null = null;
      try {
        chainNow = (await client!.getBlock({ blockNumber: head })).timestamp;
      } catch {
        chainNow = null;
      }
      const items: EscrowView[] = [];
      ordered.forEach((l, i) => {
        const s = states[i]?.result as unknown as EscrowState | undefined;
        if (!s || !taskIds[i]) return;
        items.push({
          ...s,
          taskId: taskIds[i],
          blockNumber: l.blockNumber,
          txHash: l.transactionHash,
          description: descriptions[taskIds[i]] ?? null,
        });
      });
      return { from, head, grace, items, chainNow };
    },
  });

  const grace = escrowsQuery.data?.grace ?? 0n;

  const cta = (() => {
    if (!isConnected) return "Connect a wallet to create an escrow";
    if (!onChain) return "Switch network to create an escrow";
    if (!escrowAddress) return "Deploy AgentEscrow first";
    if (phase === "done") return "Create another escrow";
    if (phase === "error") return "Try again";
    if (busy) return ["Check your wallet…", "Check your wallet…", "Confirming…"][step] ?? "Working…";
    return "Approve & lock tUSD8";
  })();
  const ctaDisabled = !onChain || !escrowAddress || busy || !enoughBalance || parsedAmount === null;

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">AgentEscrow · tUSD8 on Aevum</p>
          <h1>Agent escrow</h1>
          <p className="lede">
            Lock tUSD8 for an agent&apos;s task. The agent submits a delivery proof, you confirm, and the funds release.
            Miss the deadline and you get a refund; deliver and go unconfirmed, and the agent can claim after a 1-day grace
            period.
          </p>
        </div>
      </div>

      <div className="row">
        <section className="card stack" aria-label="Create escrow" style={{ flex: "1 1 340px" }}>
          <h2>Create escrow</h2>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
            <span style={{ color: "var(--text-muted)" }}>Agent wallet address</span>
            <input
              className="field"
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              value={agentInput}
              disabled={busy}
              onChange={(e) => setAgentInput(e.target.value)}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
            <span style={{ color: "var(--text-muted)" }}>
              Amount ({token.symbol}) · your balance:{" "}
              {balance.data !== undefined ? `${formatUnits(balance.data, token.decimals)} ${token.symbol}` : "—"}
            </span>
            <input
              className="field"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="10"
              value={amountInput}
              disabled={busy}
              onChange={(e) => setAmountInput(e.target.value)}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
            <span style={{ color: "var(--text-muted)" }}>Deadline (days from now)</span>
            <input
              className="field"
              type="number"
              min={1}
              max={365}
              step={1}
              value={daysInput}
              disabled={busy}
              onChange={(e) => setDaysInput(e.target.value)}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
            <span style={{ color: "var(--text-muted)" }}>Task description (shown in this browser only)</span>
            <input
              className="field"
              type="text"
              autoComplete="off"
              placeholder="e.g. Build a landing page for the launch"
              value={descInput}
              disabled={busy}
              onChange={(e) => setDescInput(e.target.value)}
            />
          </label>
          <dl className="kv" style={{ fontSize: 13 }}>
            <dt>Escrow contract</dt>
            <dd>{escrowAddress ? short(escrowAddress) : "not deployed"}</dd>
            <dt>Task id</dt>
            <dd>Random 32 bytes, generated when you create</dd>
          </dl>

          <ol className="steps">
            {CREATE_STEPS.map((s, i) => {
              const done = step > i || phase === "done";
              const active = busy && step === i;
              return (
                <li key={s.title} className={`step ${done ? "done" : active ? "active" : ""}`}>
                  <div className="step-dot">{done ? "✓" : i + 1}</div>
                  <div className="step-body">
                    <div className="step-top">
                      <span className="step-title">{s.title}</span>
                      <span className="step-state">{done ? "Done" : active ? "In progress…" : "Waiting"}</span>
                    </div>
                    <p className="step-who">{s.who}</p>
                  </div>
                </li>
              );
            })}
          </ol>

          {!enoughBalance && phase !== "done" && (
            <div className="notice warn" role="status">
              <strong>Not enough {token.symbol}</strong>
              <span>
                This escrow needs {amountInput || "…"} {token.symbol}. See the <Link href="/">Setup</Link> page for how to
                get test tokens.
              </span>
            </div>
          )}

          {error && (
            <div className="notice bad" role="alert">
              <strong>Escrow wasn&apos;t created</strong>
              <span>{error}</span>
            </div>
          )}

          {phase === "done" && createdTaskId && (
            <div className="notice good" role="status">
              <strong>
                Escrow created {orderLabel(createdTaskId)}
                {txCreate ? " · locked on Aevum" : ""}
              </strong>
              <span style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {hasExplorer && txApprove && (
                  <a href={txUrl(txApprove)} target="_blank" rel="noreferrer">
                    Approve tx
                  </a>
                )}
                {hasExplorer && txCreate && (
                  <a href={txUrl(txCreate)} target="_blank" rel="noreferrer">
                    Create tx
                  </a>
                )}
                <a href="#escrow-list">See it in the list below</a>
              </span>
            </div>
          )}

          <button type="button" className="btn big block" disabled={ctaDisabled} onClick={onCreate}>
            {cta}
          </button>
          <p className="fine">The approval is for the exact escrow amount, never unlimited.</p>
        </section>

        <section className="card stack" aria-label="How it works" style={{ flex: "1 1 340px" }}>
          <h2>How it works</h2>
          <ol className="steps">
            <li className="step">
              <div className="step-dot">1</div>
              <div className="step-body">
                <div className="step-top">
                  <span className="step-title">Client locks funds</span>
                </div>
                <p className="step-who">tUSD8 moves into the escrow contract until the task ends.</p>
              </div>
            </li>
            <li className="step">
              <div className="step-dot">2</div>
              <div className="step-body">
                <div className="step-top">
                  <span className="step-title">Agent delivers</span>
                </div>
                <p className="step-who">The agent submits a proof hash of the finished work.</p>
              </div>
            </li>
            <li className="step">
              <div className="step-dot">3</div>
              <div className="step-body">
                <div className="step-top">
                  <span className="step-title">Client confirms — or rejects</span>
                </div>
                <p className="step-who">
                  Funds release to the agent on confirm. Not satisfied? Reject within the 1-day grace period and the
                  agent can deliver again; no delivery by the deadline means a refund.
                </p>
              </div>
            </li>
            <li className="step">
              <div className="step-dot">4</div>
              <div className="step-body">
                <div className="step-top">
                  <span className="step-title">Grace period</span>
                </div>
                <p className="step-who">
                  If the agent delivered but the client never confirms, the agent can claim after 1 day.
                </p>
              </div>
            </li>
          </ol>
          <dl className="kv" style={{ fontSize: 13 }}>
            <dt>Token</dt>
            <dd>
              {token.symbol} · {token.address ? short(token.address) : "—"}
            </dd>
            <dt>Grace period</dt>
            <dd>{grace ? `${Number(grace) / 86400} day${Number(grace) === 86400 ? "" : "s"}` : "1 day"}</dd>
            <dt>Explorer</dt>
            <dd>
              {hasExplorer && escrowAddress ? (
                <a href={`https://explorer-test.qday.info/address/${escrowAddress}`} target="_blank" rel="noreferrer">
                  View contract
                </a>
              ) : (
                "—"
              )}
            </dd>
          </dl>
        </section>
      </div>

      <section id="escrow-list" className="card flush" aria-label="Escrows" style={{ marginTop: 24 }}>
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "16px 20px", borderBottom: "1px solid var(--line)" }}
        >
          <h2 style={{ margin: 0 }}>Escrows</h2>
          <span className="fine" style={{ marginLeft: "auto" }}>
            {escrowsQuery.data
              ? `${escrowsQuery.data.items.length} escrow${escrowsQuery.data.items.length === 1 ? "" : "s"} · from block ${escrowsQuery.data.from.toString()} · refreshes every 30s`
              : "Loading…"}
          </span>
          <button
            type="button"
            className="btn small secondary"
            disabled={!escrowsQuery.data || escrowsQuery.isFetching}
            onClick={() => void escrowsQuery.refetch()}
          >
            Refresh
          </button>
        </div>

        {!escrowAddress ? (
          <div className="card empty">
            No AgentEscrow configured for {net.label}. Set{" "}
            <code>NEXT_PUBLIC_ESCROW_{net.key.toUpperCase()}</code> in <code>web/.env.local</code>.
          </div>
        ) : escrowsQuery.error ? (
          <p className="empty">Couldn&apos;t read escrows: {(escrowsQuery.error as Error).message}</p>
        ) : escrowsQuery.data && escrowsQuery.data.items.length === 0 && !escrowsQuery.isFetching ? (
          <p className="empty">
            No escrows yet in blocks {escrowsQuery.data.from.toString()}–{escrowsQuery.data.head.toString()}. Create
            the first one above.
          </p>
        ) : (
          escrowsQuery.data?.items.map((item) => (
            <EscrowCard
              key={item.taskId}
              item={item}
              escrowAddress={escrowAddress}
              hasExplorer={hasExplorer}
              tokenDecimals={token.decimals}
              tokenSymbol={token.symbol}
              grace={grace}
              now={now}
              chainNow={escrowsQuery.data?.chainNow ?? null}
              onActionDone={() => void escrowsQuery.refetch()}
            />
          ))
        )}
        {escrowsQuery.isFetching && escrowsQuery.data && (
          <p className="fine" style={{ padding: "12px 20px" }}>
            Refreshing…
          </p>
        )}
      </section>
    </main>
  );
}

function EscrowCard({
  item,
  escrowAddress,
  hasExplorer,
  tokenDecimals,
  tokenSymbol,
  grace,
  now,
  chainNow,
  onActionDone,
}: {
  item: EscrowView;
  escrowAddress: Address;
  hasExplorer: boolean;
  tokenDecimals: number;
  tokenSymbol: string;
  grace: bigint;
  now: number;
  chainNow: bigint | null;
  onActionDone: () => void;
}) {
  const { net } = useNetwork();
  const appChain = net.chain;
  const config = useConfig();
  const { address, isConnected } = useAccount();
  const [proofText, setProofText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionTx, setActionTx] = useState<Hash | null>(null);

  const isClient = isConnected && address?.toLowerCase() === item.client.toLowerCase();
  const isAgent = isConnected && address?.toLowerCase() === item.agent.toLowerCase();
  // Prefer chain time (head block) over the local clock for all gating, so a
  // skewed clock can neither hide an action nor show one that would revert.
  const nowUsed = chainNow !== null ? Number(chainNow) : now;
  const expired = nowUsed > Number(item.deadline);
  const claimReady = item.deliveredAt > 0n && BigInt(nowUsed) > item.deliveredAt + grace;
  const claimIn = item.deliveredAt > 0n ? countdown(item.deliveredAt + grace, nowUsed) : null;

  async function send(
    label: string,
    fn: "markDelivered" | "rejectDelivery" | "confirmRelease" | "refund" | "claimUnconfirmed",
    args: [Hex, Hex] | [Hex],
  ) {
    if (!address) return;
    setBusy(label);
    setActionError(null);
    setActionTx(null);
    try {
      const { request } = await simulateContract(config, {
        account: address,
        address: escrowAddress,
        abi: agentEscrowAbi,
        // Each branch below calls this helper with a literal fn, so the
        // simulated call is typed; the cast only satisfies the shared helper.
        functionName: fn as "markDelivered",
        args: args as [Hex, Hex],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, request);
      setActionTx(hash);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain.");
      onActionDone();
    } catch (e) {
      setActionError(explain(e));
    } finally {
      setBusy(null);
    }
  }

  async function onDeliver() {
    if (!proofText.trim()) {
      setActionError("Write a short delivery note first — it is hashed and stored as the proof.");
      return;
    }
    await send("deliver", "markDelivered", [item.taskId, keccak256(toHex(proofText.trim()))]);
  }

  const statusPill =
    item.status === 3 ? "good" : item.status === 4 || item.status === 2 ? "warn" : "";

  return (
    <article style={{ padding: "18px 20px", borderTop: "1px solid var(--line)" }}>
      <div className="row-between" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span className="mono" style={{ fontWeight: 600 }}>
          {orderLabel(item.taskId)}
        </span>
        <span className={`status-pill ${statusPill}`}>{STATUS_LABELS[item.status] ?? "Unknown"}</span>
      </div>
      {item.description && <p style={{ margin: "10px 0 0" }}>{item.description}</p>}
      <dl className="kv" style={{ fontSize: 13, marginTop: 12 }}>
        <dt>Client</dt>
        <dd className="mono">
          {short(item.client)}
          {isClient ? " (you)" : ""}
        </dd>
        <dt>Agent</dt>
        <dd className="mono">
          {short(item.agent)}
          {isAgent ? " (you)" : ""}
        </dd>
        <dt>Amount</dt>
        <dd className="num">
          {formatUnits(item.amount, tokenDecimals)} {tokenSymbol}
        </dd>
        <dt>Deadline</dt>
        <dd>
          {formatDate(item.deadline)} ·{" "}
          {item.status === 1 ? countdown(item.deadline, nowUsed) : expired ? "expired" : "passed"}
        </dd>
        {item.status >= 2 && item.proof !== `0x${"0".repeat(64)}` && (
          <>
            <dt>Proof</dt>
            <dd className="mono">{short(item.proof, 10, 8)}</dd>
          </>
        )}
        <dt>Created</dt>
        <dd>
          block {item.blockNumber.toString()}{" "}
          {hasExplorer && (
            <a href={txUrl(item.txHash)} target="_blank" rel="noreferrer">
              Tx
            </a>
          )}
        </dd>
      </dl>

      {isAgent && item.status === 1 && !expired && (
        <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
          <input
            className="field"
            type="text"
            autoComplete="off"
            placeholder="Delivery note — e.g. 'Landing page shipped, commit abc123'"
            value={proofText}
            disabled={busy !== null}
            onChange={(e) => setProofText(e.target.value)}
            style={{ flex: "1 1 280px" }}
          />
          <button type="button" className="btn small" disabled={busy !== null} onClick={onDeliver}>
            {busy === "deliver" ? "Check your wallet…" : "Mark delivered"}
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        {isClient && item.status === 2 && (
          <button
            type="button"
            className="btn small"
            disabled={busy !== null}
            onClick={() => void send("release", "confirmRelease", [item.taskId])}
          >
            {busy === "release" ? "Check your wallet…" : "Confirm release"}
          </button>
        )}
        {isClient && item.status === 2 && !claimReady && (
          <button
            type="button"
            className="btn small secondary"
            disabled={busy !== null}
            title="Not satisfied with the delivery? Reject it within the 1-day grace period — the escrow reopens and the agent can deliver again before the deadline."
            onClick={() => void send("reject", "rejectDelivery", [item.taskId])}
          >
            {busy === "reject" ? "Check your wallet…" : "Reject delivery"}
          </button>
        )}
        {isClient && item.status === 1 && expired && (
          <button
            type="button"
            className="btn small warn"
            disabled={busy !== null}
            onClick={() => void send("refund", "refund", [item.taskId])}
          >
            {busy === "refund" ? "Check your wallet…" : "Refund"}
          </button>
        )}
        {isAgent && item.status === 2 && (
          <button
            type="button"
            className="btn small secondary"
            disabled={busy !== null || !claimReady}
            title={claimReady ? undefined : `You can claim ${claimIn ?? "after the grace period"}`}
            onClick={() => void send("claim", "claimUnconfirmed", [item.taskId])}
          >
            {busy === "claim" ? "Check your wallet…" : claimReady ? "Claim" : `Claim ${claimIn ?? ""}`}
          </button>
        )}
      </div>

      {actionError && (
        <div className="notice bad" role="alert" style={{ marginTop: 12 }}>
          <strong>That didn&apos;t go through</strong>
          <span>{actionError}</span>
        </div>
      )}
      {actionTx && !actionError && (
        <div className="notice good" role="status" style={{ marginTop: 12 }}>
          <strong>Transaction sent</strong>
          <span style={{ display: "flex", gap: 16 }}>
            {hasExplorer && (
              <a href={txUrl(actionTx)} target="_blank" rel="noreferrer">
                View on explorer
              </a>
            )}
          </span>
        </div>
      )}
    </article>
  );
}
