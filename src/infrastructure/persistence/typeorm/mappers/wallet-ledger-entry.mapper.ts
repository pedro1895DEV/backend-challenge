import { Money } from "../../../../domain/money/money";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../../../domain/wallet/wallet-ledger-entry";
import type { WalletLedgerEntryEntity } from "../schemas/wallet-ledger-entry.schema";

export class WalletLedgerEntryMapper {
  static toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    const currency = entity.currency.trim();
    return WalletLedgerEntry.rehydrate({
      id: entity.id,
      walletId: entity.walletId,
      transactionId: entity.transactionId,
      direction: entity.direction as LedgerDirection,
      money: Money.from({ amount: entity.amount, currency }),
      balanceBefore: Money.fromSigned({ amount: entity.balanceBefore, currency }),
      balanceAfter: Money.fromSigned({ amount: entity.balanceAfter, currency }),
      createdAt: entity.createdAt,
    });
  }

  static toEntity(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.amount,
      balanceAfter: entry.balanceAfter.amount,
      createdAt: entry.createdAt,
    };
  }
}
