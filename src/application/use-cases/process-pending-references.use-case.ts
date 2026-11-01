import { generateUuidV7 } from "../../domain/shared/uuid-v7";
import type { ReferenceRetryPolicy } from "../../domain/wagering/reference-retry-policy";
import { settleWagerTransaction } from "../../domain/wagering/wager-settlement";
import {
  WagerTransactionStatus,
  type WagerTransaction,
} from "../../domain/wagering/wager-transaction";
import { NOOP_METRICS_PORT, type MetricsPort } from "../ports/metrics.port";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import type { WagerTransactionRepository } from "../ports/wager-transaction.repository";
import { buildSettlementOutboxMessages } from "../shared/outbox-events";

export interface PendingReferenceSettlementTrace {
  transactionId: string;
  walletId: string;
  providerId: string;
  kind: string;
  outcome: "processed" | "rejected" | "rescheduled";
  status: WagerTransactionStatus;
  failureCode?: string;
  attempts: number;
}

export interface ProcessPendingReferencesResult {
  scanned: number;
  processed: number;
  rejected: number;
  rescheduled: number;
  skipped: number;
  traces?: readonly PendingReferenceSettlementTrace[];
}

/**
 * Reprocesses due `PENDING_REFERENCE` transactions (`REFUND` / `ROLLBACK` that
 * arrived before their referenced transaction — README §7.1 & §13 item 7).
 *
 * Concurrency & deadlock safety across `>= 3` simultaneous instances:
 *  - Candidate IDs are read outside a lock via `findDuePendingReferences`.
 *  - Each candidate acquires the per-wallet `SELECT ... FOR UPDATE` lock FIRST
 *    (preserving the global lock order `wallets` -> `wager_transactions`) and
 *    then re-reads the transaction row, skipping if another instance already
 *    settled or rescheduled it.
 */
export class ProcessPendingReferencesUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly txRepo: WagerTransactionRepository,
    private readonly retryPolicy?: ReferenceRetryPolicy,
    private readonly metrics: MetricsPort = NOOP_METRICS_PORT,
  ) {}

  async executeBatch(
    now: Date = new Date(),
    limit = 50,
  ): Promise<ProcessPendingReferencesResult> {
    const startedAt = performance.now();
    const candidates = await this.txRepo.findDuePendingReferences(now, limit);
    const traces: PendingReferenceSettlementTrace[] = [];
    const summary = {
      scanned: candidates.length,
      processed: 0,
      rejected: 0,
      rescheduled: 0,
      skipped: 0,
    };

    for (const candidate of candidates) {
      const result = await this.settleOne(candidate.walletId, candidate.id, now);
      if (result.outcome === "skipped") {
        summary.skipped += 1;
        continue;
      }

      summary[result.outcome] += 1;
      traces.push(result.trace);

      if (result.outcome === "rescheduled") {
        this.metrics.recordRetry("pending_reference", "reference_still_missing");
      } else {
        this.metrics.recordTransactionOutcome({
          status: result.trace.status,
          kind: result.trace.kind,
          channel: "pending_reference_worker",
          failureCode: result.trace.failureCode,
        });
      }
    }

    this.metrics.recordProcessingDuration(
      "pending_reference_batch",
      performance.now() - startedAt,
    );

    return {
      ...summary,
      traces,
    };
  }

  private async settleOne(
    walletId: string,
    transactionId: string,
    now: Date,
  ): Promise<
    | { outcome: "skipped" }
    | {
        outcome: "processed" | "rejected" | "rescheduled";
        trace: PendingReferenceSettlementTrace;
      }
  > {
    return this.unitOfWork.runInTransaction(async (tx) => {
      const wallet = await tx.wallets.findByIdForUpdate(walletId);
      if (!wallet) return { outcome: "skipped" };

      const currentTx = await tx.transactions.findById(transactionId);
      if (
        !currentTx ||
        currentTx.status !== WagerTransactionStatus.PendingReference ||
        !currentTx.isDueForReferenceRetry(now)
      ) {
        return { outcome: "skipped" };
      }

      let reference: WagerTransaction | undefined;
      let referenceAlreadyReversed = false;

      if (currentTx.referenceExternalTransactionId !== undefined) {
        reference =
          (await tx.transactions.findByProviderAndExternalId(
            currentTx.providerId,
            currentTx.referenceExternalTransactionId,
          )) ?? undefined;

        if (reference) {
          referenceAlreadyReversed = await tx.transactions.isReferenceAlreadyReversed(
            reference.id,
          );
        }
      }

      const { transaction, ledgerEntry } = settleWagerTransaction({
        wallet,
        transaction: currentTx,
        reference,
        referenceAlreadyReversed,
        ledgerEntryId: generateUuidV7(now),
        now,
        retryPolicy: this.retryPolicy,
      });

      if (ledgerEntry) {
        await tx.wallets.update(wallet);
      }
      await tx.transactions.update(transaction);
      if (ledgerEntry) {
        await tx.ledger.insert(ledgerEntry);
      }

      const outboxMessages = buildSettlementOutboxMessages({
        wallet,
        transaction,
        ledgerEntry,
        occurredAt: now,
        emitPendingReferenceEvent: false,
      });
      await tx.outbox.insertMany(outboxMessages);

      const outcome: "processed" | "rejected" | "rescheduled" =
        transaction.status === WagerTransactionStatus.Processed
          ? "processed"
          : transaction.status === WagerTransactionStatus.Rejected
            ? "rejected"
            : "rescheduled";

      return {
        outcome,
        trace: {
          transactionId: transaction.id,
          walletId: transaction.walletId,
          providerId: transaction.providerId,
          kind: transaction.kind,
          outcome,
          status: transaction.status,
          failureCode: transaction.failureCode,
          attempts: transaction.referenceAttempts,
        },
      };
    });
  }
}
