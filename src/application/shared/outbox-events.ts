import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/messaging/integration-event";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { generateUuidV7 } from "../../domain/shared/uuid-v7";
import {
  WagerTransactionStatus,
  type WagerTransaction,
} from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";

export interface BuildSettlementOutboxOptions {
  wallet: Wallet;
  transaction: WagerTransaction;
  ledgerEntry?: WalletLedgerEntry;
  correlationId?: string;
  causationId?: string;
  occurredAt: Date;
  /**
   * True on initial submission when a transaction enters `PENDING_REFERENCE`;
   * false on subsequent retry ticks that remain `PENDING_REFERENCE` so we do
   * not emit duplicate pending events on every backoff tick.
   */
  emitPendingReferenceEvent: boolean;
}

export function buildSettlementOutboxMessages(
  opts: BuildSettlementOutboxOptions,
): OutboxMessage[] {
  const correlationId = opts.correlationId?.trim() || generateUuidV7(opts.occurredAt);
  const causationId = opts.causationId?.trim() || opts.transaction.id;
  const ctx = {
    correlationId,
    causationId,
    occurredAt: opts.occurredAt,
  };

  const messages: OutboxMessage[] = [];

  if (opts.ledgerEntry) {
    messages.push(
      OutboxMessage.enqueue(WalletBalanceChanged.from(opts.wallet, opts.ledgerEntry, ctx)),
    );
  }

  switch (opts.transaction.status) {
    case WagerTransactionStatus.Processed:
      messages.push(
        OutboxMessage.enqueue(
          WagerTransactionProcessed.from(opts.transaction, opts.wallet.balance, ctx),
        ),
      );
      break;
    case WagerTransactionStatus.Rejected:
      messages.push(
        OutboxMessage.enqueue(
          WagerTransactionRejected.from(opts.transaction, opts.wallet.balance, ctx),
        ),
      );
      break;
    case WagerTransactionStatus.PendingReference:
      if (opts.emitPendingReferenceEvent) {
        messages.push(
          OutboxMessage.enqueue(
            WagerTransactionPendingReference.from(opts.transaction, opts.wallet.balance, ctx),
          ),
        );
      }
      break;
    default:
      break;
  }

  return messages;
}
