import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import { resolve } from "node:path";
import { generateUuidV7 } from "../src/domain/shared/uuid-v7";
import type { MetricsSnapshot } from "../src/infrastructure/observability/metrics.registry";

interface SpawnedReplica {
  port: number;
  baseUrl: string;
  proc: ReturnType<typeof Bun.spawn>;
}

interface WalletCreated {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

interface WagerResult {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
}

interface PhaseStats {
  name: string;
  totalRequests: number;
  concurrency: number;
  wallTimeMs: number;
  rps: number;
  statusCounts: Record<string, number>;
  error5xxCount: number;
  replaysCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

const PROJECT_ROOT = resolve(import.meta.dir, "..");

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return round2(sorted[idx]!);
}

async function allocateFreePort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close((err) => (err ? reject(err) : resolvePort(port)));
    });
  });
}

async function waitForReady(baseUrl: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health/ready`);
      if (res.status === 200) return;
    } catch {
      // still booting
    }
    await Bun.sleep(150);
  }
  throw new Error(`Instance at ${baseUrl} failed readiness check within ${timeoutMs}ms`);
}

async function spawnCluster(count: number): Promise<SpawnedReplica[]> {
  const ports = await Promise.all(Array.from({ length: count }, () => allocateFreePort()));
  const replicas: SpawnedReplica[] = ports.map((port) => {
    const proc = Bun.spawn([process.execPath, "src/main.ts"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        DB_HOST: process.env.DB_HOST ?? "localhost",
        DB_PORT: process.env.DB_PORT ?? "5432",
        DB_USER: process.env.DB_USER ?? "wagering",
        DB_PASSWORD: process.env.DB_PASSWORD ?? "wagering",
        DB_NAME: process.env.DB_NAME ?? "wagering",
        AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test",
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
        AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
        SQS_CONSUMER_ENABLED: "false",
        OUTBOX_POLL_INTERVAL_MS: "100",
        PENDING_REFERENCE_POLL_INTERVAL_MS: "200",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    return {
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      proc,
    };
  });

  await Promise.all(replicas.map((r) => waitForReady(r.baseUrl)));
  return replicas;
}

async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function loop(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]!, idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => loop());
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const externalUrls = process.env.LOAD_TEST_URLS?.split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  let spawned: SpawnedReplica[] = [];
  let baseUrls: string[];

  if (externalUrls && externalUrls.length > 0) {
    baseUrls = externalUrls;
    await Promise.all(baseUrls.map((u) => waitForReady(u)));
  } else {
    spawned = await spawnCluster(3);
    baseUrls = spawned.map((s) => s.baseUrl);
  }

  const pickUrl = (i: number): string => baseUrls[i % baseUrls.length]!;

  try {
    // Wait for background workers to drain any pre-existing outbox rows before benchmarking
    const preDrainDeadline = Date.now() + 10_000;
    while (Date.now() < preDrainDeadline) {
      const res = await fetch(`${pickUrl(0)}/metrics?format=json`);
      const snap = (await res.json()) as MetricsSnapshot;
      if (snap.outbox.pendingMessages === 0) break;
      await Bun.sleep(100);
    }

    console.log("====================================================================");
    console.log(" Distributed Wagering Processor — Load & Contention Benchmark");
    console.log("====================================================================");
    console.log(`Environment : ${os.platform()} ${os.release()} (${os.arch()})`);
    console.log(`CPU         : ${os.cpus()[0]?.model ?? "Unknown"} (${os.cpus().length} logical cores)`);
    console.log(`Memory      : ${round2(os.totalmem() / 1024 ** 3)} GB`);
    console.log(`Runtime     : Bun ${Bun.version}`);
    console.log(`Cluster     : ${baseUrls.length} active HTTP+Worker instances (${baseUrls.join(", ")})`);
    console.log("--------------------------------------------------------------------");

    // ------------------------------------------------------------------
    // Setup: Open 24 independent wallets (1,000.00 BRL each) + 1 hot wallet (500.00 BRL)
    // ------------------------------------------------------------------
    const multiWalletCount = 24;
    const multiWallets = await runPool(
      Array.from({ length: multiWalletCount }, (_, i) => i),
      12,
      async (i) => {
        const res = await fetch(`${pickUrl(i)}/wallets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            playerId: `load-player-${i}-${generateUuidV7()}`,
            initialBalance: { amount: "1000.00", currency: "BRL" },
          }),
        });
        if (res.status !== 201) {
          throw new Error(`Failed to create wallet #${i}: HTTP ${res.status}`);
        }
        return (await res.json()) as WalletCreated;
      },
    );

    const hotWalletRes = await fetch(`${pickUrl(0)}/wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: `load-hot-player-${generateUuidV7()}`,
        initialBalance: { amount: "500.00", currency: "BRL" },
      }),
    });
    if (hotWalletRes.status !== 201) {
      throw new Error(`Failed to create hot wallet: HTTP ${hotWalletRes.status}`);
    }
    const hotWallet = (await hotWalletRes.json()) as WalletCreated;

    // ------------------------------------------------------------------
    // Phase 1: Distributed Multi-Wallet Workload (24 wallets x 25 ops = 600 tx, concurrency 36)
    // Mix per wallet: 15 BETs (10.00), 6 WINs (15.00), 4 LOSSes (0.00)
    // ------------------------------------------------------------------
    interface WagerTask {
      targetUrl: string;
      idempotencyKey: string;
      body: Record<string, unknown>;
    }

    const phase1Tasks: WagerTask[] = [];
    const opsPerWallet = 25;
    for (let step = 0; step < opsPerWallet; step++) {
      for (let wIdx = 0; wIdx < multiWallets.length; wIdx++) {
        const w = multiWallets[wIdx]!;
        const kind = step % 5 === 3 ? "WIN" : step % 5 === 4 ? "LOSS" : "BET";
        const amount = kind === "WIN" ? "15.00" : kind === "LOSS" ? "0.00" : "10.00";
        const extId = `p1-w${wIdx}-s${step}-${generateUuidV7()}`;
        const key = `provider-load:${extId}`;
        phase1Tasks.push({
          targetUrl: pickUrl(phase1Tasks.length),
          idempotencyKey: key,
          body: {
            providerId: "provider-load",
            externalTransactionId: extId,
            playerId: w.playerId,
            walletId: w.id,
            roundId: `round-w${wIdx}-${Math.floor(step / 2)}`,
            gameId: "fortune-chimp",
            kind,
            money: { amount, currency: "BRL" },
          },
        });
      }
    }

    const phase1Stats = await executePhase("Phase 1 — Multi-Wallet Parallel Throughput (24 wallets)", phase1Tasks, 36);

    // ------------------------------------------------------------------
    // Phase 2: Single Hot-Wallet Contention & Idempotency Storm
    // 1 Hot Wallet (500.00 BRL): 120 unique 10.00 BRL BETs + 60 duplicate replays = 180 reqs @ concurrency 45
    // Expected: exactly 50 PROCESSED, 70 REJECTED (INSUFFICIENT_FUNDS), 60 replays, final balance 0.00 BRL
    // ------------------------------------------------------------------
    const uniqueHotBets: WagerTask[] = Array.from({ length: 120 }, (_, i) => {
      const extId = `p2-hot-${i}-${generateUuidV7()}`;
      return {
        targetUrl: pickUrl(i),
        idempotencyKey: `provider-load:${extId}`,
        body: {
          providerId: "provider-load",
          externalTransactionId: extId,
          playerId: hotWallet.playerId,
          walletId: hotWallet.id,
          roundId: `round-hot-${i}`,
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "10.00", currency: "BRL" },
        },
      };
    });

    const duplicateHotReplays: WagerTask[] = Array.from({ length: 60 }, (_, i) => {
      const original = uniqueHotBets[i % 30]!;
      return {
        targetUrl: pickUrl(i + 1), // intentionally hit a different replica!
        idempotencyKey: original.idempotencyKey,
        body: original.body,
      };
    });

    // Interleave unique bets and cross-replica duplicate replays
    const phase2Tasks: WagerTask[] = [];
    for (let i = 0; i < uniqueHotBets.length; i++) {
      phase2Tasks.push(uniqueHotBets[i]!);
      if (i % 2 === 1 && duplicateHotReplays[Math.floor(i / 2)]) {
        phase2Tasks.push(duplicateHotReplays[Math.floor(i / 2)]!);
      }
    }

    const phase2Stats = await executePhase(
      "Phase 2 — Single Hot-Wallet Contention & Duplicate Storm (1 wallet)",
      phase2Tasks,
      45,
    );

    // ------------------------------------------------------------------
    // Phase 3: Wait for Outbox Drain & Audit All 25 Wallets via Reconciliation
    // ------------------------------------------------------------------
    const drainStart = performance.now();
    let pendingOutbox = Number.POSITIVE_INFINITY;
    const drainDeadline = Date.now() + 15_000;
    while (Date.now() < drainDeadline) {
      const res = await fetch(`${pickUrl(0)}/metrics?format=json`);
      const snap = (await res.json()) as MetricsSnapshot;
      pendingOutbox = snap.outbox.pendingMessages;
      if (pendingOutbox === 0) break;
      await Bun.sleep(50);
    }
    const outboxDrainWaitMs = round2(performance.now() - drainStart);

    const allWallets = [...multiWallets, hotWallet];
    const reconciliations = await runPool(allWallets, 10, async (w, idx) => {
      const res = await fetch(`${pickUrl(idx)}/wallets/${w.id}/reconciliation`, {
        method: "POST",
      });
      if (res.status !== 200) {
        throw new Error(`Reconciliation HTTP ${res.status} for wallet ${w.id}`);
      }
      return (await res.json()) as {
        walletId: string;
        storedBalance: { amount: string; currency: string };
        calculatedBalance: { amount: string; currency: string };
        difference: { amount: string; currency: string };
        consistent: boolean;
        checkedEntries: number;
      };
    });

    const consistentCount = reconciliations.filter(
      (r) => r.consistent && r.difference.amount === "0.00",
    ).length;
    const hotReconciliation = reconciliations[reconciliations.length - 1]!;

    // Scrape server-side metrics across all 3 instances
    const snapshots = await Promise.all(
      baseUrls.map(async (u) => {
        const res = await fetch(`${u}/metrics?format=json`);
        return (await res.json()) as MetricsSnapshot;
      }),
    );

    let totalProcessed = 0;
    let totalRejected = 0;
    let totalDuplicates = 0;
    let totalHotContention = 0;
    let totalUniqueRaces = 0;
    let totalDeadlocksOrTimeouts = 0;
    let totalOutboxPublished = 0;
    const outboxLagP95s: number[] = [];
    const outboxLagMaxes: number[] = [];

    for (const s of snapshots) {
      totalProcessed += s.transactions.byStatus.PROCESSED ?? 0;
      totalRejected += s.transactions.byStatus.REJECTED ?? 0;
      totalDuplicates += s.duplicatesDetected.total;
      totalHotContention += s.lockConflicts.byType.hot_wallet_contention ?? 0;
      totalUniqueRaces += s.lockConflicts.byType.unique_constraint_race ?? 0;
      totalDeadlocksOrTimeouts += s.lockConflicts.byType.lock_timeout_or_deadlock ?? 0;
      totalOutboxPublished += s.outbox.publishedTotal;
      if (s.outbox.deliveryLagMs.count > 0) {
        outboxLagP95s.push(s.outbox.deliveryLagMs.p95Ms);
        outboxLagMaxes.push(s.outbox.deliveryLagMs.maxMs);
      }
    }

    for (const stats of [phase1Stats, phase2Stats]) {
      console.log(`\n[${stats.name}]`);
      console.log(`  Requests / Concurrency : ${stats.totalRequests} reqs @ concurrency ${stats.concurrency}`);
      console.log(`  Wall Time / Throughput : ${stats.wallTimeMs} ms (${stats.rps} req/s)`);
      console.log(`  Latency (client HTTP)  : p50=${stats.p50Ms}ms | p95=${stats.p95Ms}ms | p99=${stats.p99Ms}ms | max=${stats.maxMs}ms`);
      console.log(`  HTTP Statuses          : ${JSON.stringify(stats.statusCounts)} (replays=${stats.replaysCount})`);
      console.log(`  5xx Error Rate         : ${round2((stats.error5xxCount / stats.totalRequests) * 100)}% (${stats.error5xxCount}/${stats.totalRequests})`);
    }

    console.log("\n[Cluster-Wide Server Metrics & Invariant Audit]");
    console.log(`  Committed PROCESSED    : ${totalProcessed}`);
    console.log(`  Committed REJECTED     : ${totalRejected}`);
    console.log(`  Duplicates Detected    : ${totalDuplicates}`);
    console.log(`  Hot-Wallet Contention  : ${totalHotContention} in-process lock waits | ${totalUniqueRaces} unique-index races | ${totalDeadlocksOrTimeouts} deadlocks/timeouts`);
    console.log(`  Outbox Events Drained  : ${totalOutboxPublished} published (pending=${pendingOutbox}, drainWait=${outboxDrainWaitMs}ms)`);
    console.log(
      `  Outbox Delivery Lag    : max p95 across replicas=${
        outboxLagP95s.length ? Math.max(...outboxLagP95s) : 0
      }ms | max=${outboxLagMaxes.length ? Math.max(...outboxLagMaxes) : 0}ms`,
    );
    console.log(`  Hot-Wallet Final State : balance=${hotReconciliation.storedBalance.amount} BRL | ledgerEntries=${hotReconciliation.checkedEntries} (1 OPENING + 50 BETs = 51 expected)`);
    console.log(`  Ledger Reconciliation  : ${consistentCount}/${allWallets.length} wallets consistent (difference = 0.00 BRL)`);
    console.log("====================================================================");

    if (
      phase1Stats.error5xxCount > 0 ||
      phase2Stats.error5xxCount > 0 ||
      consistentCount !== allWallets.length ||
      hotReconciliation.storedBalance.amount !== "0.00" ||
      hotReconciliation.checkedEntries !== 51 ||
      pendingOutbox !== 0
    ) {
      throw new Error("Load test invariant check failed!");
    }
  } finally {
    for (const replica of spawned) {
      try {
        replica.proc.kill();
      } catch {
        // ignore
      }
    }
    if (spawned.length > 0) {
      await Promise.allSettled(spawned.map((r) => r.proc.exited));
    }
  }
}

async function executePhase(
  name: string,
  tasks: ReadonlyArray<{
    targetUrl: string;
    idempotencyKey: string;
    body: Record<string, unknown>;
  }>,
  concurrency: number,
): Promise<PhaseStats> {
  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  let error5xxCount = 0;
  let replaysCount = 0;

  const phaseStart = performance.now();

  await runPool(tasks, concurrency, async (task) => {
    const reqStart = performance.now();
    const res = await fetch(`${task.targetUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": task.idempotencyKey,
      },
      body: JSON.stringify(task.body),
    });
    const elapsed = performance.now() - reqStart;
    latencies.push(elapsed);

    const codeKey = String(res.status);
    statusCounts[codeKey] = (statusCounts[codeKey] ?? 0) + 1;
    if (res.status >= 500) {
      error5xxCount += 1;
    } else if (res.status === 200 || res.status === 422 || res.status === 202) {
      const payload = (await res.json()) as WagerResult;
      if (payload.idempotentReplay) {
        replaysCount += 1;
      }
    }
  });

  const wallTimeMs = round2(performance.now() - phaseStart);
  const sorted = [...latencies].sort((a, b) => a - b);

  return {
    name,
    totalRequests: tasks.length,
    concurrency,
    wallTimeMs,
    rps: round2((tasks.length / wallTimeMs) * 1000),
    statusCounts,
    error5xxCount,
    replaysCount,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted.length > 0 ? round2(sorted[sorted.length - 1]!) : 0,
  };
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});
