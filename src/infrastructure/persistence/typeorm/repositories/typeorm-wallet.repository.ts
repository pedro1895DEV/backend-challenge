import type { DataSource, EntityManager, Repository } from "typeorm";
import type { TransactionalWalletRepository } from "../../../../application/ports/wallet.repository";
import type { Wallet } from "../../../../domain/wallet/wallet";
import { WalletMapper } from "../mappers/wallet.mapper";
import { WalletEntitySchema, type WalletEntity } from "../schemas/wallet.schema";

export class TypeOrmWalletRepository implements TransactionalWalletRepository {
  private readonly repo: Repository<WalletEntity>;

  constructor(public readonly manager: DataSource | EntityManager) {
    this.repo = manager.getRepository(WalletEntitySchema);
  }

  async findById(id: string): Promise<Wallet | null> {
    const entity = await this.repo.findOneBy({ id });
    return entity ? WalletMapper.toDomain(entity) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const entity = await this.repo
      .createQueryBuilder("w")
      .setLock("pessimistic_write")
      .where("w.id = :id", { id })
      .getOne();
    return entity ? WalletMapper.toDomain(entity) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.repo.findOneBy({ playerId, currency });
    return entity ? WalletMapper.toDomain(entity) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    const entity = WalletMapper.toEntity(wallet);
    await this.repo.insert(entity);
  }

  async update(wallet: Wallet): Promise<void> {
    const entity = WalletMapper.toEntity(wallet);
    await this.repo.update(
      { id: entity.id },
      {
        balance: entity.balance,
        version: entity.version,
        updatedAt: entity.updatedAt,
      },
    );
  }

  async save(wallet: Wallet): Promise<void> {
    const entity = WalletMapper.toEntity(wallet);
    await this.repo.save(entity);
  }
}
