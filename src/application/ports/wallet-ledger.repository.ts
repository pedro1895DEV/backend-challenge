import type { Money } from "../../domain/money/money";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";

export const WALLET_LEDGER_REPOSITORY = Symbol("WALLET_LEDGER_REPOSITORY");

export interface LedgerPaginationOptions {
  cursor?: string; // opaque base64url cursor
  limit?: number;
}

export interface PaginatedLedgerEntries {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
  totalCount: number;
}

export interface WalletLedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  save(entry: WalletLedgerEntry): Promise<void>;
  findByWalletId(walletId: string, options?: LedgerPaginationOptions): Promise<PaginatedLedgerEntries>;
  calculateBalance(walletId: string, currency: string): Promise<{ balance: Money; count: number }>;
}
