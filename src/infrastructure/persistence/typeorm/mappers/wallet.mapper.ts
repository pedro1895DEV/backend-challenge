import { Money } from "../../../../domain/money/money";
import { Wallet } from "../../../../domain/wallet/wallet";
import type { WalletEntity } from "../schemas/wallet.schema";

export class WalletMapper {
  static toDomain(entity: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency.trim(),
      balance: Money.fromSigned({ amount: entity.balance, currency: entity.currency.trim() }),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  static toEntity(wallet: Wallet): WalletEntity {
    const state = wallet.toState();
    return {
      id: state.id,
      playerId: state.playerId,
      currency: state.currency,
      balance: state.balance.amount,
      version: state.version,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  }
}
