import type { MoneyProps } from "../../domain/money/money";
import { WalletNotFoundError } from "../errors/application-errors";
import type { WalletRepository } from "../ports/wallet.repository";
import { requireNonEmptyString } from "../shared/validation";

export interface WalletDetailsOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export class GetWalletUseCase {
  constructor(private readonly walletRepo: WalletRepository) {}

  async execute(rawWalletId: unknown): Promise<WalletDetailsOutput> {
    const walletId = requireNonEmptyString(rawWalletId, "walletId", 64);
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }
}
