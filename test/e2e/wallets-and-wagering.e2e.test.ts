import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { DataSource } from "typeorm";
import { AppModule } from "../../src/app.module";
import { UnauthenticatedError } from "../../src/application/errors/application-errors";
import {
  PROVIDER_IDENTITY_PORT,
  type AuthenticatedCaller,
  type HttpHeadersMap,
  type ProviderIdentityPort,
} from "../../src/application/ports/provider-identity.port";
import { generateUuidV7 } from "../../src/domain/shared/uuid-v7";
import type { HttpErrorEnvelope } from "../../src/infrastructure/http/filters/http-exception.filter";
import { LoggingReconciliationObserver } from "../../src/infrastructure/observability/logging-reconciliation-observer";
import { DATA_SOURCE } from "../../src/infrastructure/persistence/database.module";

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
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  money: MoneyJson;
  balance: MoneyJson | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
  createdAt: string;
  processedAt: string | null;
}

interface ReconcileWalletJson {
  walletId: string;
  storedBalance: MoneyJson;
  calculatedBalance: MoneyJson;
  difference: MoneyJson;
  consistent: boolean;
  checkedEntries: number;
}

describe("Wallets & Wagering HTTP API (e2e — Real PostgreSQL)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let dataSource: DataSource;
  let reconciliationObserver: LoggingReconciliationObserver;
  const createdWalletIds: string[] = [];

  beforeAll(async () => {
    process.env.DB_HOST ??= "localhost";
    process.env.DB_PORT ??= "5432";
    process.env.DB_USER ??= "wagering";
    process.env.DB_PASSWORD ??= "wagering";
    process.env.DB_NAME ??= "wagering";
    process.env.AWS_ENDPOINT_URL ??= "http://localhost:4566";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    baseUrl = await app.getUrl();

    dataSource = app.get<DataSource>(DATA_SOURCE);
    reconciliationObserver = app.get(LoggingReconciliationObserver);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function postJson<T>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; headers: Headers; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      headers: res.headers,
      body: (await res.json()) as T,
    };
  }

  async function getJson<T>(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; headers: Headers; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, { headers });
    return {
      status: res.status,
      headers: res.headers,
      body: (await res.json()) as T,
    };
  }

  describe("POST /wallets, GET /wallets/:walletId, GET /wallets/:walletId/ledger", () => {
    it("opens a wallet with positive balance, creating OPENING tx and CREDIT ledger entry atomically", async () => {
      const playerId = `player-${generateUuidV7()}`;
      const res = await postJson<OpenWalletJson>(
        "/wallets",
        {
          playerId,
          initialBalance: { amount: "1000.00", currency: "BRL" },
        },
        { "X-Correlation-Id": "corr-open-wallet-1" },
      );

      expect(res.status).toBe(201);
      expect(res.headers.get("x-correlation-id")).toBe("corr-open-wallet-1");
      expect(res.body).toEqual({
        id: expect.any(String),
        playerId,
        balance: { amount: "1000.00", currency: "BRL" },
        version: 1,
      });
      createdWalletIds.push(res.body.id);

      const getRes = await getJson<WalletDetailsJson>(`/wallets/${res.body.id}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
      expect(getRes.body.version).toBe(1);

      const ledgerRes = await getJson<ListWalletLedgerJson>(`/wallets/${res.body.id}/ledger`);
      expect(ledgerRes.status).toBe(200);
      expect(ledgerRes.body.items).toHaveLength(1);
      expect(ledgerRes.body.nextCursor).toBeNull();
      const openingEntry = ledgerRes.body.items[0]!;
      expect(openingEntry.direction).toBe("CREDIT");
      expect(openingEntry.money).toEqual({ amount: "1000.00", currency: "BRL" });
      expect(openingEntry.balanceBefore).toEqual({ amount: "0.00", currency: "BRL" });
      expect(openingEntry.balanceAfter).toEqual({ amount: "1000.00", currency: "BRL" });

      // Verify internal OPENING transaction was stored in the same transaction
      const openingTxRes = await getJson<WagerTransactionDetailsJson>(
        `/wagering/transactions/${openingEntry.transactionId}`,
      );
      expect(openingTxRes.status).toBe(200);
      expect(openingTxRes.body.kind).toBe("OPENING");
      expect(openingTxRes.body.status).toBe("PROCESSED");
    });

    it("opens a wallet with 0.00 initialBalance without creating any ledger entry", async () => {
      const playerId = `player-${generateUuidV7()}`;
      const res = await postJson<OpenWalletJson>("/wallets", {
        playerId,
        initialBalance: { amount: "0.00", currency: "USD" },
      });

      expect(res.status).toBe(201);
      expect(res.body.balance).toEqual({ amount: "0.00", currency: "USD" });
      expect(res.body.version).toBe(1);
      createdWalletIds.push(res.body.id);

      const ledgerRes = await getJson<ListWalletLedgerJson>(`/wallets/${res.body.id}/ledger`);
      expect(ledgerRes.status).toBe(200);
      expect(ledgerRes.body.items).toHaveLength(0);
    });

    it("returns 409 Conflict on duplicate (playerId, currency), while allowing another currency", async () => {
      const playerId = `player-${generateUuidV7()}`;

      const first = await postJson<OpenWalletJson>("/wallets", {
        playerId,
        initialBalance: { amount: "50.00", currency: "BRL" },
      });
      expect(first.status).toBe(201);
      createdWalletIds.push(first.body.id);

      const dup = await postJson<HttpErrorEnvelope>("/wallets", {
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe("DUPLICATE_WALLET");

      const eur = await postJson<OpenWalletJson>("/wallets", {
        playerId,
        initialBalance: { amount: "50.00", currency: "EUR" },
      });
      expect(eur.status).toBe(201);
      createdWalletIds.push(eur.body.id);
    });

    it("rejects numeric money, negative amounts, and missing fields with 400", async () => {
      const numericRes = await postJson<HttpErrorEnvelope>("/wallets", {
        playerId: `player-${generateUuidV7()}`,
        initialBalance: { amount: 100, currency: "BRL" },
      });
      expect(numericRes.status).toBe(400);
      expect(numericRes.body.error.code).toBe("INVALID_MONEY");

      const negativeRes = await postJson<HttpErrorEnvelope>("/wallets", {
        playerId: `player-${generateUuidV7()}`,
        initialBalance: { amount: "-10.00", currency: "BRL" },
      });
      expect(negativeRes.status).toBe(400);

      const notFoundWallet = await getJson<HttpErrorEnvelope>(`/wallets/${generateUuidV7()}`);
      expect(notFoundWallet.status).toBe(404);
      expect(notFoundWallet.body.error.code).toBe("WALLET_NOT_FOUND");
    });
  });

  describe("POST /wagering/transactions — full round lifecycle, business rules & queries", () => {
    it("processes BET, WIN, LOSS, REFUND, ROLLBACK and paginates ledger with stable opaque cursor", async () => {
      const playerId = `player-${generateUuidV7()}`;
      const providerId = `prov-${generateUuidV7().slice(0, 8)}`;
      const walletRes = await postJson<OpenWalletJson>("/wallets", {
        playerId,
        initialBalance: { amount: "500.00", currency: "BRL" },
      });
      expect(walletRes.status).toBe(201);
      const walletId = walletRes.body.id;
      createdWalletIds.push(walletId);

      // 1. BET 100.00 -> 400.00 (version 2)
      const bet1 = await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "bet-1",
          playerId,
          walletId,
          roundId: "round-1",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "100.00", currency: "BRL" },
        },
        { "Idempotency-Key": `${providerId}:bet-1` },
      );
      expect(bet1.status).toBe(200);
      expect(bet1.body).toEqual({
        transactionId: expect.any(String),
        status: "PROCESSED",
        balance: { amount: "400.00", currency: "BRL" },
        idempotentReplay: false,
      });

      // 2. WIN 250.00 referencing bet-1 -> 650.00 (version 3)
      const win1 = await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "win-1",
          playerId,
          walletId,
          roundId: "round-1",
          gameId: "fortune-chimp",
          kind: "WIN",
          money: { amount: "250.00", currency: "BRL" },
          referenceExternalTransactionId: "bet-1",
        },
        { "Idempotency-Key": `${providerId}:win-1` },
      );
      expect(win1.status).toBe(200);
      expect(win1.body.balance).toEqual({ amount: "650.00", currency: "BRL" });

      // Query WIN by provider + externalTransactionId
      const winLookup = await getJson<WagerTransactionDetailsJson>(
        `/providers/${providerId}/wagering/transactions/win-1`,
      );
      expect(winLookup.status).toBe(200);
      expect(winLookup.body.referenceTransactionId).toBe(bet1.body.transactionId);

      // 3. LOSS 0.00 -> balance unchanged (650.00), version stays 3, NO ledger entry
      const walletBeforeLoss = await getJson<WalletDetailsJson>(`/wallets/${walletId}`);
      expect(walletBeforeLoss.body.version).toBe(3);

      const loss1 = await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "loss-1",
          playerId,
          walletId,
          roundId: "round-2",
          gameId: "fortune-chimp",
          kind: "LOSS",
          money: { amount: "0.00", currency: "BRL" },
        },
        { "Idempotency-Key": `${providerId}:loss-1` },
      );
      expect(loss1.status).toBe(200);
      expect(loss1.body.status).toBe("PROCESSED");
      expect(loss1.body.balance).toEqual({ amount: "650.00", currency: "BRL" });

      const walletAfterLoss = await getJson<WalletDetailsJson>(`/wallets/${walletId}`);
      expect(walletAfterLoss.body.version).toBe(3);

      // 4. Second BET + REFUND -> 650.00 - 50.00 + 50.00 = 650.00 (versions 4 and 5)
      const bet2 = await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "bet-2",
          playerId,
          walletId,
          roundId: "round-3",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "50.00", currency: "BRL" },
        },
        { "Idempotency-Key": `${providerId}:bet-2` },
      );
      expect(bet2.status).toBe(200);
      expect(bet2.body.balance).toEqual({ amount: "600.00", currency: "BRL" });

      const refund2 = await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "refund-2",
          playerId,
          walletId,
          roundId: "round-3",
          gameId: "fortune-chimp",
          kind: "REFUND",
          money: { amount: "50.00", currency: "BRL" },
          referenceExternalTransactionId: "bet-2",
        },
        { "Idempotency-Key": `${providerId}:refund-2` },
      );
      expect(refund2.status).toBe(200);
      expect(refund2.body.balance).toEqual({ amount: "650.00", currency: "BRL" });

      // Attempting a second reversal (ROLLBACK or REFUND) on bet-2 -> 422 REFERENCE_ALREADY_REVERSED
      const doubleReverse = await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "rollback-2",
          playerId,
          walletId,
          roundId: "round-3",
          gameId: "fortune-chimp",
          kind: "ROLLBACK",
          money: { amount: "50.00", currency: "BRL" },
          referenceExternalTransactionId: "bet-2",
        },
        { "Idempotency-Key": `${providerId}:rollback-2` },
      );
      expect(doubleReverse.status).toBe(422);
      expect(doubleReverse.body.status).toBe("REJECTED");
      expect(doubleReverse.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");

      // Paginate all 5 ledger entries (OPENING, BET1, WIN1, BET2, REFUND2) with limit=2
      const collectedIds: string[] = [];
      let cursor: string | null = null;
      do {
        const qs: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
        const page = await getJson<ListWalletLedgerJson>(`/wallets/${walletId}/ledger${qs}`);
        expect(page.status).toBe(200);
        for (const item of page.body.items) {
          collectedIds.push(item.id);
        }
        cursor = page.body.nextCursor;
      } while (cursor !== null);

      expect(collectedIds).toHaveLength(5);
      expect(new Set(collectedIds).size).toBe(5);

      // Invalid cursor & invalid limit return 400
      const badCursor = await getJson<HttpErrorEnvelope>(
        `/wallets/${walletId}/ledger?cursor=not-valid-base64-json`,
      );
      expect(badCursor.status).toBe(400);
      expect(badCursor.body.error.code).toBe("INVALID_CURSOR");

      const badLimit = await getJson<HttpErrorEnvelope>(`/wallets/${walletId}/ledger?limit=500`);
      expect(badLimit.status).toBe(400);
      expect(badLimit.body.error.code).toBe("INVALID_QUERY_PARAM");
    });

    it("persists REJECTED transactions (422) without touching balance/ledger, and distinguishes REVERSAL_INSUFFICIENT_FUNDS", async () => {
      const playerId = `player-${generateUuidV7()}`;
      const providerId = `prov-${generateUuidV7().slice(0, 8)}`;
      const walletRes = await postJson<OpenWalletJson>("/wallets", {
        playerId,
        initialBalance: { amount: "30.00", currency: "BRL" },
      });
      const walletId = walletRes.body.id;
      createdWalletIds.push(walletId);

      // 1. BET 100.00 against 30.00 -> 422 INSUFFICIENT_FUNDS, persisted & auditable
      const rejectedBet = await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "bet-overdraft",
          playerId,
          walletId,
          roundId: "r-over",
          gameId: "slots",
          kind: "BET",
          money: { amount: "100.00", currency: "BRL" },
        },
        { "Idempotency-Key": `${providerId}:bet-overdraft` },
      );
      expect(rejectedBet.status).toBe(422);
      expect(rejectedBet.body).toEqual({
        transactionId: expect.any(String),
        status: "REJECTED",
        failureCode: "INSUFFICIENT_FUNDS",
        balance: { amount: "30.00", currency: "BRL" },
        idempotentReplay: false,
      });

      // Rejected transaction is persisted and queryable via GET
      const getRejected = await getJson<WagerTransactionDetailsJson>(
        `/wagering/transactions/${rejectedBet.body.transactionId}`,
      );
      expect(getRejected.status).toBe(200);
      expect(getRejected.body.status).toBe("REJECTED");
      expect(getRejected.body.failureCode).toBe("INSUFFICIENT_FUNDS");

      // 2. WIN 50.00 -> 80.00, then BET 70.00 -> 10.00, then ROLLBACK WIN 50.00 -> 422 REVERSAL_INSUFFICIENT_FUNDS
      await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "win-50",
          playerId,
          walletId,
          roundId: "r-win",
          gameId: "slots",
          kind: "WIN",
          money: { amount: "50.00", currency: "BRL" },
        },
        { "Idempotency-Key": `${providerId}:win-50` },
      );

      await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "bet-spend-70",
          playerId,
          walletId,
          roundId: "r-spend",
          gameId: "slots",
          kind: "BET",
          money: { amount: "70.00", currency: "BRL" },
        },
        { "Idempotency-Key": `${providerId}:bet-spend-70` },
      );

      const rollbackWin = await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "rollback-win-50",
          playerId,
          walletId,
          roundId: "r-win",
          gameId: "slots",
          kind: "ROLLBACK",
          money: { amount: "50.00", currency: "BRL" },
          referenceExternalTransactionId: "win-50",
        },
        { "Idempotency-Key": `${providerId}:rollback-win-50` },
      );
      expect(rollbackWin.status).toBe(422);
      expect(rollbackWin.body.status).toBe("REJECTED");
      expect(rollbackWin.body.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
      expect(rollbackWin.body.balance).toEqual({ amount: "10.00", currency: "BRL" });

      // 3. CURRENCY_MISMATCH preserves wallet's true currency across initial call AND idempotent replay
      const currencyMismatchKey = `${providerId}:bet-usd`;
      const usdPayload = {
        providerId,
        externalTransactionId: "bet-usd",
        playerId,
        walletId,
        roundId: "r-usd",
        gameId: "slots",
        kind: "BET",
        money: { amount: "5.00", currency: "USD" },
      };
      const mismatch1 = await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        usdPayload,
        { "Idempotency-Key": currencyMismatchKey },
      );
      expect(mismatch1.status).toBe(422);
      expect(mismatch1.body.failureCode).toBe("CURRENCY_MISMATCH");
      expect(mismatch1.body.balance).toEqual({ amount: "10.00", currency: "BRL" });

      const mismatchReplay = await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        usdPayload,
        { "Idempotency-Key": currencyMismatchKey },
      );
      expect(mismatchReplay.status).toBe(422);
      expect(mismatchReplay.body.idempotentReplay).toBe(true);
      expect(mismatchReplay.body.balance).toEqual({ amount: "10.00", currency: "BRL" });
    });

    it("accepts out-of-order REFUND/ROLLBACK as 202 PENDING_REFERENCE and rejects external OPENING or missing Idempotency-Key with 400", async () => {
      const playerId = `player-${generateUuidV7()}`;
      const providerId = `prov-${generateUuidV7().slice(0, 8)}`;
      const walletRes = await postJson<OpenWalletJson>("/wallets", {
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      });
      const walletId = walletRes.body.id;
      createdWalletIds.push(walletId);

      const pendingKey = `${providerId}:refund-early`;
      const pendingPayload = {
        providerId,
        externalTransactionId: "refund-early",
        playerId,
        walletId,
        roundId: "r-early",
        gameId: "slots",
        kind: "REFUND",
        money: { amount: "20.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-not-arrived-yet",
      };

      const pendingRes = await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        pendingPayload,
        { "Idempotency-Key": pendingKey },
      );
      expect(pendingRes.status).toBe(202);
      expect(pendingRes.body).toEqual({
        transactionId: expect.any(String),
        status: "PENDING_REFERENCE",
        balance: { amount: "100.00", currency: "BRL" },
        idempotentReplay: false,
      });

      // Replay of PENDING_REFERENCE returns 202 with idempotentReplay: true
      const pendingReplay = await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        pendingPayload,
        { "Idempotency-Key": pendingKey },
      );
      expect(pendingReplay.status).toBe(202);
      expect(pendingReplay.body.idempotentReplay).toBe(true);
      expect(pendingReplay.body.transactionId).toBe(pendingRes.body.transactionId);

      // Missing Idempotency-Key -> 400
      const noHeader = await postJson<HttpErrorEnvelope>("/wagering/transactions", {
        providerId,
        externalTransactionId: "no-key",
        playerId,
        walletId,
        roundId: "r-1",
        gameId: "slots",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      });
      expect(noHeader.status).toBe(400);
      expect(noHeader.body.error.code).toBe("MISSING_IDEMPOTENCY_KEY");

      // External OPENING -> 400
      const openingAttempt = await postJson<HttpErrorEnvelope>(
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "ext-opening",
          playerId,
          walletId,
          roundId: "r-1",
          gameId: "slots",
          kind: "OPENING",
          money: { amount: "10.00", currency: "BRL" },
        },
        { "Idempotency-Key": `${providerId}:ext-opening` },
      );
      expect(openingAttempt.status).toBe(400);
    });
  });

  describe("Idempotency & Per-Wallet Concurrency (README §8 & §9)", () => {
    it("returns original observed balance snapshot on idempotent replay even after subsequent balance changes, and 409 on payload mismatch", async () => {
      const playerId = `player-${generateUuidV7()}`;
      const providerId = `prov-${generateUuidV7().slice(0, 8)}`;
      const walletRes = await postJson<OpenWalletJson>("/wallets", {
        playerId,
        initialBalance: { amount: "200.00", currency: "BRL" },
      });
      const walletId = walletRes.body.id;
      createdWalletIds.push(walletId);

      const key1 = `${providerId}:idem-tx-1`;
      const tx1Payload = {
        providerId,
        externalTransactionId: "idem-tx-1",
        playerId,
        walletId,
        roundId: "round-idem",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      };

      const first = await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        tx1Payload,
        { "Idempotency-Key": key1 },
      );
      expect(first.status).toBe(200);
      expect(first.body.balance).toEqual({ amount: "175.00", currency: "BRL" });
      expect(first.body.idempotentReplay).toBe(false);

      // Mutate wallet balance afterwards via a second transaction (175.00 -> 100.00)
      const second = await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        {
          providerId,
          externalTransactionId: "idem-tx-2",
          playerId,
          walletId,
          roundId: "round-idem",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "75.00", currency: "BRL" },
        },
        { "Idempotency-Key": `${providerId}:idem-tx-2` },
      );
      expect(second.status).toBe(200);
      expect(second.body.balance).toEqual({ amount: "100.00", currency: "BRL" });

      // Replay first transaction (even with unnormalized "25.0" which normalizes to "25.00" in payloadHash)
      // Must return the ORIGINAL observed snapshot "175.00", NOT current "100.00"!
      const replay = await postJson<ProcessWagerJson>(
        "/wagering/transactions",
        { ...tx1Payload, money: { amount: "25.0", currency: "BRL" } },
        { "Idempotency-Key": key1 },
      );
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({
        transactionId: first.body.transactionId,
        status: "PROCESSED",
        balance: { amount: "175.00", currency: "BRL" },
        idempotentReplay: true,
      });

      // Same Idempotency-Key with divergent payload -> 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH
      const conflict = await postJson<HttpErrorEnvelope>(
        "/wagering/transactions",
        { ...tx1Payload, money: { amount: "30.00", currency: "BRL" } },
        { "Idempotency-Key": key1 },
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe("IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");

      // Different Idempotency-Key with duplicate (providerId, externalTransactionId) -> 409 DUPLICATE_EXTERNAL_TRANSACTION
      const dupExt = await postJson<HttpErrorEnvelope>(
        "/wagering/transactions",
        tx1Payload,
        { "Idempotency-Key": `${providerId}:different-key-same-ext` },
      );
      expect(dupExt.status).toBe(409);
      expect(dupExt.body.error.code).toBe("DUPLICATE_EXTERNAL_TRANSACTION");
    });

    it("mandatory §8 scenario: 100.00 BRL wallet with two concurrent 80.00 BRL bets -> 1 PROCESSED, 1 REJECTED, final balance 20.00, 1 debit entry", async () => {
      const playerId = `player-${generateUuidV7()}`;
      const providerId = `prov-${generateUuidV7().slice(0, 8)}`;
      const walletRes = await postJson<OpenWalletJson>("/wallets", {
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      });
      const walletId = walletRes.body.id;
      createdWalletIds.push(walletId);

      const [resA, resB] = await Promise.all([
        postJson<ProcessWagerJson>(
          "/wagering/transactions",
          {
            providerId,
            externalTransactionId: "race-80-a",
            playerId,
            walletId,
            roundId: "round-race",
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "80.00", currency: "BRL" },
          },
          { "Idempotency-Key": `${providerId}:race-80-a` },
        ),
        postJson<ProcessWagerJson>(
          "/wagering/transactions",
          {
            providerId,
            externalTransactionId: "race-80-b",
            playerId,
            walletId,
            roundId: "round-race",
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "80.00", currency: "BRL" },
          },
          { "Idempotency-Key": `${providerId}:race-80-b` },
        ),
      ]);

      const statuses = [resA.status, resB.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 422]);

      const processed = resA.status === 200 ? resA.body : resB.body;
      const rejected = resA.status === 422 ? resA.body : resB.body;

      expect(processed.status).toBe("PROCESSED");
      expect(processed.balance).toEqual({ amount: "20.00", currency: "BRL" });
      expect(rejected.status).toBe("REJECTED");
      expect(rejected.failureCode).toBe("INSUFFICIENT_FUNDS");

      const finalWallet = await getJson<WalletDetailsJson>(`/wallets/${walletId}`);
      expect(finalWallet.body.balance).toEqual({ amount: "20.00", currency: "BRL" });

      const ledger = await getJson<ListWalletLedgerJson>(`/wallets/${walletId}/ledger`);
      const debits = ledger.body.items.filter((e) => e.direction === "DEBIT");
      expect(debits).toHaveLength(1);
    });

    it("deduplicates 20 parallel identical requests into 1 debit and 19 idempotent replays", async () => {
      const playerId = `player-${generateUuidV7()}`;
      const providerId = `prov-${generateUuidV7().slice(0, 8)}`;
      const walletRes = await postJson<OpenWalletJson>("/wallets", {
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      });
      const walletId = walletRes.body.id;
      createdWalletIds.push(walletId);

      const sharedKey = `${providerId}:parallel-20`;
      const payload = {
        providerId,
        externalTransactionId: "parallel-20",
        playerId,
        walletId,
        roundId: "round-p20",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "15.00", currency: "BRL" },
      };

      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          postJson<ProcessWagerJson>("/wagering/transactions", payload, {
            "Idempotency-Key": sharedKey,
          }),
        ),
      );

      for (const r of responses) {
        expect(r.status).toBe(200);
        expect(r.body.status).toBe("PROCESSED");
        expect(r.body.balance).toEqual({ amount: "85.00", currency: "BRL" });
      }

      const txIds = new Set(responses.map((r) => r.body.transactionId));
      expect(txIds.size).toBe(1);

      const freshCount = responses.filter((r) => !r.body.idempotentReplay).length;
      const replayCount = responses.filter((r) => r.body.idempotentReplay).length;
      expect(freshCount).toBe(1);
      expect(replayCount).toBe(19);

      const finalWallet = await getJson<WalletDetailsJson>(`/wallets/${walletId}`);
      expect(finalWallet.body.balance).toEqual({ amount: "85.00", currency: "BRL" });
    });
  });

  describe("POST /wallets/:walletId/reconciliation", () => {
    it("flags tampered storedBalance, increments divergence counter, and NEVER silently overwrites storedBalance", async () => {
      const playerId = `player-${generateUuidV7()}`;
      const walletRes = await postJson<OpenWalletJson>("/wallets", {
        playerId,
        initialBalance: { amount: "300.00", currency: "BRL" },
      });
      const walletId = walletRes.body.id;
      createdWalletIds.push(walletId);

      // 1. Consistent check
      const cleanRecon = await postJson<ReconcileWalletJson>(
        `/wallets/${walletId}/reconciliation`,
        {},
      );
      expect(cleanRecon.status).toBe(200);
      expect(cleanRecon.body).toEqual({
        walletId,
        storedBalance: { amount: "300.00", currency: "BRL" },
        calculatedBalance: { amount: "300.00", currency: "BRL" },
        difference: { amount: "0.00", currency: "BRL" },
        consistent: true,
        checkedEntries: 1,
      });

      // 2. Simulate unexpected out-of-band DB corruption (+13.37)
      const divergencesBefore = reconciliationObserver.divergencesTotal;
      await dataSource.query(`UPDATE wallets SET balance = 313.37 WHERE id = $1`, [walletId]);

      try {
        const driftedRecon = await postJson<ReconcileWalletJson>(
          `/wallets/${walletId}/reconciliation`,
          {},
        );
        expect(driftedRecon.status).toBe(200);
        expect(driftedRecon.body).toEqual({
          walletId,
          storedBalance: { amount: "313.37", currency: "BRL" },
          calculatedBalance: { amount: "300.00", currency: "BRL" },
          difference: { amount: "13.37", currency: "BRL" },
          consistent: false,
          checkedEntries: 1,
        });
        expect(reconciliationObserver.divergencesTotal).toBe(divergencesBefore + 1);

        // Verify reconciliation did NOT silently auto-correct storedBalance!
        const afterReconWallet = await getJson<WalletDetailsJson>(`/wallets/${walletId}`);
        expect(afterReconWallet.body.balance).toEqual({ amount: "313.37", currency: "BRL" });
      } finally {
        // Restore wallet so the global test invariant check passes across all test wallets
        await dataSource.query(`UPDATE wallets SET balance = 300.00 WHERE id = $1`, [walletId]);
      }
    });
  });

  describe("Authentication Extension Point (ProviderIdentityPort + AuthGuard + @Public())", () => {
    it("allows @Public() /health/* without auth, enforces 401 when unauthenticated, and 403 on cross-provider access", async () => {
      class StubOidcIdentityAdapter implements ProviderIdentityPort {
        async authenticate(headers: HttpHeadersMap): Promise<AuthenticatedCaller> {
          const auth = headers.authorization;
          const token = Array.isArray(auth) ? auth[0] : auth;
          if (!token || !token.startsWith("Bearer provider:")) {
            throw new UnauthenticatedError("Missing or invalid OIDC Bearer token");
          }
          const providerId = token.slice("Bearer provider:".length).trim();
          return {
            subject: `client:${providerId}`,
            providerId,
            scopes: ["wallets:write", "wallets:read", "wagering:write", "wagering:read"],
          };
        }
      }

      const authModuleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PROVIDER_IDENTITY_PORT)
        .useClass(StubOidcIdentityAdapter)
        .compile();

      const authApp = authModuleRef.createNestApplication({ logger: false });
      await authApp.listen(0);
      const authUrl = await authApp.getUrl();

      try {
        // 1. Health endpoints bypass AuthGuard (@Public())
        const liveRes = await fetch(`${authUrl}/health/live`);
        expect(liveRes.status).toBe(200);

        const readyRes = await fetch(`${authUrl}/health/ready`);
        expect(readyRes.status).toBe(200);

        // 2. Protected route without token -> 401
        const unauthRes = await fetch(`${authUrl}/wallets`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            playerId: `player-${generateUuidV7()}`,
            initialBalance: { amount: "50.00", currency: "BRL" },
          }),
        });
        expect(unauthRes.status).toBe(401);

        // 3. Authenticated wallet open + cross-provider transaction submission -> 403 Forbidden
        const openRes = await fetch(`${authUrl}/wallets`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer provider:provider-alpha",
          },
          body: JSON.stringify({
            playerId: `player-${generateUuidV7()}`,
            initialBalance: { amount: "50.00", currency: "BRL" },
          }),
        });
        expect(openRes.status).toBe(201);
        const openedWallet = (await openRes.json()) as OpenWalletJson;
        createdWalletIds.push(openedWallet.id);

        const forbiddenTx = await fetch(`${authUrl}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer provider:provider-alpha",
            "idempotency-key": "provider-beta:spoof-1",
          },
          body: JSON.stringify({
            providerId: "provider-beta",
            externalTransactionId: "spoof-1",
            playerId: openedWallet.playerId,
            walletId: openedWallet.id,
            roundId: "r-auth",
            gameId: "slots",
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
          }),
        });
        expect(forbiddenTx.status).toBe(403);
        const forbiddenBody = (await forbiddenTx.json()) as HttpErrorEnvelope;
        expect(forbiddenBody.error.code).toBe("PROVIDER_IDENTITY_MISMATCH");

        // 4. Matching provider succeeds -> 200
        const allowedTx = await fetch(`${authUrl}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer provider:provider-alpha",
            "idempotency-key": "provider-alpha:legit-1",
          },
          body: JSON.stringify({
            providerId: "provider-alpha",
            externalTransactionId: "legit-1",
            playerId: openedWallet.playerId,
            walletId: openedWallet.id,
            roundId: "r-auth",
            gameId: "slots",
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
          }),
        });
        expect(allowedTx.status).toBe(200);
      } finally {
        await authApp.close();
      }
    });
  });

  describe("Final Financial Invariant (wallet.balance == ledger reconstructed balance)", () => {
    it("holds across every wallet created during the e2e test suite", async () => {
      expect(createdWalletIds.length).toBeGreaterThan(0);
      for (const walletId of createdWalletIds) {
        const recon = await postJson<ReconcileWalletJson>(
          `/wallets/${walletId}/reconciliation`,
          {},
        );
        expect(recon.status).toBe(200);
        expect(recon.body.consistent).toBe(true);
        expect(recon.body.difference.amount).toBe("0.00");
      }
    });
  });
});
