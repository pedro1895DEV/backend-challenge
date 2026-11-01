import { Money, type MoneyProps } from "../../domain/money/money";
import { generateUuidV7 } from "../../domain/shared/uuid-v7";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { DuplicateWalletError, UniqueConstraintError } from "../errors/application-errors";
import type { UnitOfWork } from "../ports/unit-of-work.port";
import { buildSettlementOutboxMessages } from "../shared/outbox-events";
import { requireMoneyProps, requireNonEmptyString } from "../shared/validation";

export interface OpenWalletInput {
  playerId: unknown;
  initialBalance: unknown;
  correlationId?: string;
  now?: Date;
}

export interface OpenWalletOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class OpenWalletUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(input: OpenWalletInput): Promise<OpenWalletOutput> {
    const playerId = requireNonEmptyString(input.playerId, "playerId", 64);
    const initialMoneyProps = requireMoneyProps(input.initialBalance, "initialBalance");
    const initialBalance = Money.from(initialMoneyProps);
    const now = input.now ?? new Date();

    try {
      const wallet = await this.unitOfWork.runInTransaction(async (tx) => {
        const existing = await tx.wallets.findByPlayerAndCurrency(
          playerId,
          initialBalance.currency,
        );
        if (existing) {
          throw new DuplicateWalletError(playerId, initialBalance.currency);
        }

        const walletId = generateUuidV7(now);

        if (initialBalance.isPositive()) {
          const openingTransactionId = generateUuidV7(now);
          const openingLedgerEntryId = generateUuidV7(now);

          const { wallet: openedWallet, openingEntry } = Wallet.open({
            id: walletId,
            playerId,
            initialBalance,
            at: now,
            opening: {
              transactionId: openingTransactionId,
              ledgerEntryId: openingLedgerEntryId,
            },
          });

          const openingTx = WagerTransaction.opening({
            id: openingTransactionId,
            walletId,
            playerId,
            money: initialBalance,
            at: now,
          });

          await tx.wallets.insert(openedWallet);
          await tx.transactions.insert(openingTx);
          if (openingEntry) {
            await tx.ledger.insert(openingEntry);
          }
          const outboxMessages = buildSettlementOutboxMessages({
            wallet: openedWallet,
            transaction: openingTx,
            ledgerEntry: openingEntry,
            correlationId: input.correlationId,
            occurredAt: now,
            emitPendingReferenceEvent: false,
          });
          await tx.outbox.insertMany(outboxMessages);
          return openedWallet;
        }

        const { wallet: openedWallet } = Wallet.open({
          id: walletId,
          playerId,
          initialBalance,
          at: now,
        });
        await tx.wallets.insert(openedWallet);
        return openedWallet;
      });

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    } catch (error) {
      if (error instanceof UniqueConstraintError && error.constraint === "uq_wallets_player_currency") {
        throw new DuplicateWalletError(playerId, initialBalance.currency);
      }
      throw error;
    }
  }
}
