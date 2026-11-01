import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { DataSource } from "typeorm";
import { loadConfig } from "../../../src/config/app-config";
import { generateUuidV7 } from "../../../src/domain/shared/uuid-v7";
import { createDataSource } from "../../../src/infrastructure/persistence/typeorm/data-source";

interface MoneyJson {
  amount: string;
  currency: string;
}

interface OpenWalletJson {
  id: string;
  playerId: string;
  balance: MoneyJson;
  version: number;
}

interface WalletDetailsJson extends OpenWalletJson {
  createdAt: string;
  updatedAt: string;
}

interface LedgerEntryJson {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  money: MoneyJson;
  balanceBefore: MoneyJson;
  balanceAfter: MoneyJson;
  createdAt: string;
}

interface ListWalletLedgerJson {
  walletId: string;
  items: LedgerEntryJson[];
  nextCursor: string | null;
}

interface ProcessWagerJson {
  transactionId: string;
  status: string;
  balance: MoneyJson;
  idempotentReplay: boolean;
  failureCode?: string;
}

interface WagerTransactionDetailsJson {
  transactionId: string;
  status: string;
  kind: string;
  money: MoneyJson;
  balance: MoneyJson | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
}

interface ReconcileWalletJson {
  walletId: string;
  storedBalance: MoneyJson;
  calculatedBalance: MoneyJson;
  difference: MoneyJson;
  consistent: boolean;
  checkedEntries: number;
}

interface SpawnedInstance {
  port: number;
  baseUrl: string;
  proc: ReturnType<typeof Bun.spawn>;
}

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

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

async function waitForReady(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health/ready`);
      if (res.status === 200) return;
    } catch {
      // process still booting
    }
    await Bun.sleep(100);
  }
  throw new Error(`Instance at ${baseUrl} did not become ready within ${timeoutMs}ms`);
}

function spawnAppInstance(port: number): SpawnedInstance {
  const proc = Bun.spawn([process.execPath, "src/main.ts"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DB_HOST: process.env.DB_HOST ?? "localhost",
      DB_PORT: process.env.DB_PORT ?? "5432",
      DB_USER: process.env.DB_USER ?? "wagering",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "wagering",
      DB_NAME: process.env.DB_NAME ?? "wagering",
      AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
      PENDING_REFERENCE_POLL_INTERVAL_MS: "150",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    proc,
  };
}

async function stopInstance(instance: SpawnedInstance): Promise<void> {
  try {
    instance.proc.kill();
    await Promise.race([instance.proc.exited, Bun.sleep(5_000)]);
  } catch {
    // already exited
  }
}

describe("Multi-Instance Concurrency & Recovery (>= 3 OS Processes + Real PostgreSQL — README §8 & §13)", () => {
  const instances: SpawnedInstance[] = [];
  const allWalletIds: string[] = [];
  let dataSource: DataSource;

  beforeAll(async () => {
    process.env.DB_HOST ??= "localhost";
    process.env.DB_PORT ??= "5432";
    process.env.DB_USER ??= "wagering";
    process.env.DB_PASSWORD ??= "wagering";
    process.env.DB_NAME ??= "wagering";
    process.env.AWS_ENDPOINT_URL ??= "http://localhost:4566";

    const config = loadConfig(process.env);
    dataSource = createDataSource(config.database);
    await dataSource.initialize();
    await dataSource.runMigrations();

    // Boot 3 completely separate OS processes (zero shared memory) simultaneously
    const ports = await Promise.all([allocateFreePort(), allocateFreePort(), allocateFreePort()]);
    for (const port of ports) {
      instances.push(spawnAppInstance(port));
    }
    await Promise.all(instances.map((inst) => waitForReady(inst.baseUrl)));
  }, 30_000);

  afterAll(async () => {
    await Promise.all(instances.map((inst) => stopInstance(inst)));
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  function urlFor(index: number): string {
    return instances[index % instances.length]!.baseUrl;
  }

  async function postAt<T>(
    baseUrl: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  async function getAt<T>(baseUrl: string, path: string): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, body: (await res.json()) as T };
  }

  it("§13.1 + §13.4: same bet sent 50 times in parallel across 3 OS processes -> 1 single debit and 49 replays", async () => {
    const playerId = `p-50x-${generateUuidV7()}`;
    const providerId = `prov-50x-${generateUuidV7().slice(0, 8)}`;

    const opened = await postAt<OpenWalletJson>(urlFor(0), "/wallets", {
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    expect(opened.status).toBe(201);
    const walletId = opened.body.id;
    allWalletIds.push(walletId);

    const idempotencyKey = `${providerId}:bet-50x`;
    const payload = {
      providerId,
      externalTransactionId: "bet-50x",
      playerId,
      walletId,
      roundId: "round-50x",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    };

    // Fire 50 simultaneous HTTP requests spread round-robin across the 3 OS processes
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, idx) =>
        postAt<ProcessWagerJson>(urlFor(idx), "/wagering/transactions", payload, {
          "Idempotency-Key": idempotencyKey,
        }),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("PROCESSED");
      expect(res.body.balance).toEqual({ amount: "75.00", currency: "BRL" });
    }

    const uniqueTxIds = new Set(responses.map((r) => r.body.transactionId));
    expect(uniqueTxIds.size).toBe(1);

    const freshCount = responses.filter((r) => !r.body.idempotentReplay).length;
    const replayCount = responses.filter((r) => r.body.idempotentReplay).length;
    expect(freshCount).toBe(1);
    expect(replayCount).toBe(49);

    // Inspect wallet & ledger on a different instance
    const wallet = await getAt<WalletDetailsJson>(urlFor(2), `/wallets/${walletId}`);
    expect(wallet.body.balance).toEqual({ amount: "75.00", currency: "BRL" });
    expect(wallet.body.version).toBe(2);

    const ledger = await getAt<ListWalletLedgerJson>(urlFor(1), `/wallets/${walletId}/ledger`);
    const debits = ledger.body.items.filter((e) => e.direction === "DEBIT");
    expect(debits).toHaveLength(1);
  }, 15_000);

  it("§8 + §13.2: contesting same wallet balance across 3 processes (mandatory 100 vs 2x80 + 30-way hot wallet race)", async () => {
    // Part A: Exact mandatory §8 scenario across Instance 0 and Instance 1
    const playerId = `p-s8-${generateUuidV7()}`;
    const providerId = `prov-s8-${generateUuidV7().slice(0, 8)}`;

    const opened = await postAt<OpenWalletJson>(urlFor(0), "/wallets", {
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const walletId = opened.body.id;
    allWalletIds.push(walletId);

    const [betA, betB] = await Promise.all([
      postAt<ProcessWagerJson>(
        urlFor(0),
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "s8-bet-a",
          playerId,
          walletId,
          roundId: "round-s8",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "80.00", currency: "BRL" },
        },
        { "Idempotency-Key": `${providerId}:s8-bet-a` },
      ),
      postAt<ProcessWagerJson>(
        urlFor(1),
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "s8-bet-b",
          playerId,
          walletId,
          roundId: "round-s8",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "80.00", currency: "BRL" },
        },
        { "Idempotency-Key": `${providerId}:s8-bet-b` },
      ),
    ]);

    expect([betA.status, betB.status].sort((a, b) => a - b)).toEqual([200, 422]);
    const winner = betA.status === 200 ? betA.body : betB.body;
    const loser = betA.status === 422 ? betA.body : betB.body;

    expect(winner.status).toBe("PROCESSED");
    expect(winner.balance).toEqual({ amount: "20.00", currency: "BRL" });
    expect(loser.status).toBe("REJECTED");
    expect(loser.failureCode).toBe("INSUFFICIENT_FUNDS");

    // Retrying both on Instance 2 must NOT duplicate any debit
    const [retryA, retryB] = await Promise.all([
      postAt<ProcessWagerJson>(
        urlFor(2),
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "s8-bet-a",
          playerId,
          walletId,
          roundId: "round-s8",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "80.00", currency: "BRL" },
        },
        { "Idempotency-Key": `${providerId}:s8-bet-a` },
      ),
      postAt<ProcessWagerJson>(
        urlFor(2),
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "s8-bet-b",
          playerId,
          walletId,
          roundId: "round-s8",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "80.00", currency: "BRL" },
        },
        { "Idempotency-Key": `${providerId}:s8-bet-b` },
      ),
    ]);
    expect(retryA.body.idempotentReplay).toBe(true);
    expect(retryB.body.idempotentReplay).toBe(true);

    const s8Wallet = await getAt<WalletDetailsJson>(urlFor(2), `/wallets/${walletId}`);
    expect(s8Wallet.body.balance).toEqual({ amount: "20.00", currency: "BRL" });
    const s8Ledger = await getAt<ListWalletLedgerJson>(urlFor(2), `/wallets/${walletId}/ledger`);
    expect(s8Ledger.body.items.filter((e) => e.direction === "DEBIT")).toHaveLength(1);

    // Part B: 30 concurrent bets of 20.00 BRL contesting 300.00 BRL across 3 processes -> 15 PROCESSED, 15 REJECTED, balance 0.00
    const hotPlayer = `p-hot-${generateUuidV7()}`;
    const hotWalletRes = await postAt<OpenWalletJson>(urlFor(1), "/wallets", {
      playerId: hotPlayer,
      initialBalance: { amount: "300.00", currency: "BRL" },
    });
    const hotWalletId = hotWalletRes.body.id;
    allWalletIds.push(hotWalletId);

    const hotResponses = await Promise.all(
      Array.from({ length: 30 }, (_, idx) =>
        postAt<ProcessWagerJson>(
          urlFor(idx),
          "/wagering/transactions",
          {
            providerId,
            externalTransactionId: `hot-bet-${idx}`,
            playerId: hotPlayer,
            walletId: hotWalletId,
            roundId: `round-hot-${idx}`,
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "20.00", currency: "BRL" },
          },
          { "Idempotency-Key": `${providerId}:hot-bet-${idx}` },
        ),
      ),
    );

    const processedHot = hotResponses.filter((r) => r.status === 200);
    const rejectedHot = hotResponses.filter((r) => r.status === 422);
    expect(processedHot).toHaveLength(15);
    expect(rejectedHot).toHaveLength(15);
    for (const rej of rejectedHot) {
      expect(rej.body.failureCode).toBe("INSUFFICIENT_FUNDS");
    }

    const hotWalletFinal = await getAt<WalletDetailsJson>(urlFor(0), `/wallets/${hotWalletId}`);
    expect(hotWalletFinal.body.balance).toEqual({ amount: "0.00", currency: "BRL" });
    expect(hotWalletFinal.body.version).toBe(16); // 1 (open) + 15 debits
  }, 20_000);

  it("§13.3: processes 12 distinct wallets in parallel across 3 processes without cross-wallet blocking", async () => {
    const providerId = `prov-par-${generateUuidV7().slice(0, 8)}`;

    const wallets = await Promise.all(
      Array.from({ length: 12 }, async (_, idx) => {
        const res = await postAt<OpenWalletJson>(urlFor(idx), "/wallets", {
          playerId: `p-par-${idx}-${generateUuidV7()}`,
          initialBalance: { amount: "200.00", currency: "BRL" },
        });
        expect(res.status).toBe(201);
        allWalletIds.push(res.body.id);
        return res.body;
      }),
    );

    // For each wallet in parallel: 2 BETs of 30.00 (-60.00), 1 WIN of 45.00 (+45.00), 1 LOSS of 0.00 => final 185.00 BRL
    await Promise.all(
      wallets.flatMap((w, wIdx) => [
        postAt<ProcessWagerJson>(
          urlFor(wIdx),
          "/wagering/transactions",
          {
            providerId,
            externalTransactionId: `w${wIdx}-bet1`,
            playerId: w.playerId,
            walletId: w.id,
            roundId: `r-${wIdx}-1`,
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "30.00", currency: "BRL" },
          },
          { "Idempotency-Key": `${providerId}:w${wIdx}-bet1` },
        ),
        postAt<ProcessWagerJson>(
          urlFor(wIdx + 1),
          "/wagering/transactions",
          {
            providerId,
            externalTransactionId: `w${wIdx}-bet2`,
            playerId: w.playerId,
            walletId: w.id,
            roundId: `r-${wIdx}-2`,
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "30.00", currency: "BRL" },
          },
          { "Idempotency-Key": `${providerId}:w${wIdx}-bet2` },
        ),
        postAt<ProcessWagerJson>(
          urlFor(wIdx + 2),
          "/wagering/transactions",
          {
            providerId,
            externalTransactionId: `w${wIdx}-win1`,
            playerId: w.playerId,
            walletId: w.id,
            roundId: `r-${wIdx}-1`,
            gameId: "fortune-chimp",
            kind: "WIN",
            money: { amount: "45.00", currency: "BRL" },
          },
          { "Idempotency-Key": `${providerId}:w${wIdx}-win1` },
        ),
        postAt<ProcessWagerJson>(
          urlFor(wIdx),
          "/wagering/transactions",
          {
            providerId,
            externalTransactionId: `w${wIdx}-loss1`,
            playerId: w.playerId,
            walletId: w.id,
            roundId: `r-${wIdx}-2`,
            gameId: "fortune-chimp",
            kind: "LOSS",
            money: { amount: "0.00", currency: "BRL" },
          },
          { "Idempotency-Key": `${providerId}:w${wIdx}-loss1` },
        ),
      ]),
    );

    for (const [idx, w] of wallets.entries()) {
      const details = await getAt<WalletDetailsJson>(urlFor(idx), `/wallets/${w.id}`);
      expect(details.body.balance).toEqual({ amount: "185.00", currency: "BRL" });
      expect(details.body.version).toBe(4); // open(1) + bet1(2) + bet2(3) + win1(4); loss does not bump version
    }
  }, 20_000);

  it("§7.1 + §13.7: settles out-of-order REFUND and ROLLBACK delivered BEFORE their referenced BET across 3 active workers", async () => {
    const providerId = `prov-ooo-${generateUuidV7().slice(0, 8)}`;

    // Case 1: REFUND arrives on Instance 0 BEFORE BET arrives on Instance 1
    const playerRefund = `p-ooo-ref-${generateUuidV7()}`;
    const wRefundRes = await postAt<OpenWalletJson>(urlFor(0), "/wallets", {
      playerId: playerRefund,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const wRefundId = wRefundRes.body.id;
    allWalletIds.push(wRefundId);

    const earlyRefund = await postAt<ProcessWagerJson>(
      urlFor(0),
      "/wagering/transactions",
      {
        providerId,
        externalTransactionId: "refund-before-bet",
        playerId: playerRefund,
        walletId: wRefundId,
        roundId: "round-ooo-1",
        gameId: "fortune-chimp",
        kind: "REFUND",
        money: { amount: "40.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-arriving-later-1",
      },
      { "Idempotency-Key": `${providerId}:refund-before-bet` },
    );
    expect(earlyRefund.status).toBe(202);
    expect(earlyRefund.body.status).toBe("PENDING_REFERENCE");

    // Case 2: ROLLBACK arrives on Instance 2 BEFORE BET arrives on Instance 0
    const playerRollback = `p-ooo-rb-${generateUuidV7()}`;
    const wRollbackRes = await postAt<OpenWalletJson>(urlFor(2), "/wallets", {
      playerId: playerRollback,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const wRollbackId = wRollbackRes.body.id;
    allWalletIds.push(wRollbackId);

    const earlyRollback = await postAt<ProcessWagerJson>(
      urlFor(2),
      "/wagering/transactions",
      {
        providerId,
        externalTransactionId: "rollback-before-bet",
        playerId: playerRollback,
        walletId: wRollbackId,
        roundId: "round-ooo-2",
        gameId: "fortune-chimp",
        kind: "ROLLBACK",
        money: { amount: "55.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-arriving-later-2",
      },
      { "Idempotency-Key": `${providerId}:rollback-before-bet` },
    );
    expect(earlyRollback.status).toBe(202);
    expect(earlyRollback.body.status).toBe("PENDING_REFERENCE");

    // Now deliver both referenced BETs on different instances
    const [lateBet1, lateBet2] = await Promise.all([
      postAt<ProcessWagerJson>(
        urlFor(1),
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "bet-arriving-later-1",
          playerId: playerRefund,
          walletId: wRefundId,
          roundId: "round-ooo-1",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "40.00", currency: "BRL" },
        },
        { "Idempotency-Key": `${providerId}:bet-arriving-later-1` },
      ),
      postAt<ProcessWagerJson>(
        urlFor(0),
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "bet-arriving-later-2",
          playerId: playerRollback,
          walletId: wRollbackId,
          roundId: "round-ooo-2",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "55.00", currency: "BRL" },
        },
        { "Idempotency-Key": `${providerId}:bet-arriving-later-2` },
      ),
    ]);
    expect(lateBet1.status).toBe(200);
    expect(lateBet2.status).toBe(200);

    // Wait for the scheduled PendingReferenceWorker (running across all 3 instances) to settle both
    const deadline = Date.now() + 8_000;
    let settledRefund: WagerTransactionDetailsJson | null = null;
    let settledRollback: WagerTransactionDetailsJson | null = null;

    while (Date.now() < deadline) {
      const [r1, r2] = await Promise.all([
        getAt<WagerTransactionDetailsJson>(
          urlFor(2),
          `/wagering/transactions/${earlyRefund.body.transactionId}`,
        ),
        getAt<WagerTransactionDetailsJson>(
          urlFor(1),
          `/wagering/transactions/${earlyRollback.body.transactionId}`,
        ),
      ]);
      if (r1.body.status === "PROCESSED" && r2.body.status === "PROCESSED") {
        settledRefund = r1.body;
        settledRollback = r2.body;
        break;
      }
      await Bun.sleep(150);
    }

    expect(settledRefund?.status).toBe("PROCESSED");
    expect(settledRefund?.referenceTransactionId).toBe(lateBet1.body.transactionId);
    expect(settledRollback?.status).toBe("PROCESSED");
    expect(settledRollback?.referenceTransactionId).toBe(lateBet2.body.transactionId);

    // Both wallets must be back to 100.00 BRL with exactly 3 ledger entries (OPENING, BET, REFUND/ROLLBACK)
    const [w1Final, w2Final, l1Final, l2Final] = await Promise.all([
      getAt<WalletDetailsJson>(urlFor(0), `/wallets/${wRefundId}`),
      getAt<WalletDetailsJson>(urlFor(1), `/wallets/${wRollbackId}`),
      getAt<ListWalletLedgerJson>(urlFor(0), `/wallets/${wRefundId}/ledger`),
      getAt<ListWalletLedgerJson>(urlFor(1), `/wallets/${wRollbackId}/ledger`),
    ]);

    expect(w1Final.body.balance).toEqual({ amount: "100.00", currency: "BRL" });
    expect(w2Final.body.balance).toEqual({ amount: "100.00", currency: "BRL" });
    expect(l1Final.body.items).toHaveLength(3);
    expect(l2Final.body.items).toHaveLength(3);
  }, 15_000);

  it("§13.8: preserves full idempotency and financial consistency across instance kill and restart", async () => {
    const playerId = `p-restart-${generateUuidV7()}`;
    const providerId = `prov-restart-${generateUuidV7().slice(0, 8)}`;

    // Create wallet & bet on Instance 1 before killing it
    const opened = await postAt<OpenWalletJson>(instances[1]!.baseUrl, "/wallets", {
      playerId,
      initialBalance: { amount: "150.00", currency: "BRL" },
    });
    const walletId = opened.body.id;
    allWalletIds.push(walletId);

    const preRestartKey = `${providerId}:pre-restart-bet`;
    const preRestartPayload = {
      providerId,
      externalTransactionId: "pre-restart-bet",
      playerId,
      walletId,
      roundId: "round-restart",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "40.00", currency: "BRL" },
    };

    const preBet = await postAt<ProcessWagerJson>(
      instances[1]!.baseUrl,
      "/wagering/transactions",
      preRestartPayload,
      { "Idempotency-Key": preRestartKey },
    );
    expect(preBet.status).toBe(200);
    expect(preBet.body.balance).toEqual({ amount: "110.00", currency: "BRL" });

    // Terminate Instance 1, process another bet on Instance 0 while Instance 1 is down, then restart Instance 1
    const restartedPort = instances[1]!.port;
    await stopInstance(instances[1]!);

    const midBet = await postAt<ProcessWagerJson>(
      instances[0]!.baseUrl,
      "/wagering/transactions",
      {
        providerId,
        externalTransactionId: "during-outage-bet",
        playerId,
        walletId,
        roundId: "round-restart",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "20.00", currency: "BRL" },
      },
      { "Idempotency-Key": `${providerId}:during-outage-bet` },
    );
    expect(midBet.status).toBe(200);
    expect(midBet.body.balance).toEqual({ amount: "90.00", currency: "BRL" });

    // Reboot Instance 1 on the exact same port
    instances[1] = spawnAppInstance(restartedPort);
    await waitForReady(instances[1]!.baseUrl);

    // Replaying the pre-restart bet against the freshly rebooted Instance 1 must return the ORIGINAL snapshot (110.00)!
    const replayAfterRestart = await postAt<ProcessWagerJson>(
      instances[1]!.baseUrl,
      "/wagering/transactions",
      preRestartPayload,
      { "Idempotency-Key": preRestartKey },
    );
    expect(replayAfterRestart.status).toBe(200);
    expect(replayAfterRestart.body).toEqual({
      transactionId: preBet.body.transactionId,
      status: "PROCESSED",
      balance: { amount: "110.00", currency: "BRL" },
      idempotentReplay: true,
    });

    // Current balance on restarted Instance 1 must reflect 90.00 BRL
    const walletAfterRestart = await getAt<WalletDetailsJson>(
      instances[1]!.baseUrl,
      `/wallets/${walletId}`,
    );
    expect(walletAfterRestart.body.balance).toEqual({ amount: "90.00", currency: "BRL" });
  }, 25_000);

  it("Final Invariant (§13): wallet.balance == ledger reconstructed balance across EVERY wallet in the suite", async () => {
    expect(allWalletIds.length).toBeGreaterThanOrEqual(17);

    const results = await Promise.all(
      allWalletIds.map((walletId, idx) =>
        postAt<ReconcileWalletJson>(urlFor(idx), `/wallets/${walletId}/reconciliation`, {}),
      ),
    );

    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.body.consistent).toBe(true);
      expect(res.body.difference.amount).toBe("0.00");
    }
  });
});
