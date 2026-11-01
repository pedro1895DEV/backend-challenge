import type { Wallet } from "../../domain/wallet/wallet";

export const WALLET_REPOSITORY = Symbol("WALLET_REPOSITORY");

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  update(wallet: Wallet): Promise<void>;
  save(wallet: Wallet): Promise<void>;
}

export interface TransactionalWalletRepository extends WalletRepository {
  /** Acquires a row-level `SELECT ... FOR UPDATE` lock scoped to `id`. */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
}
