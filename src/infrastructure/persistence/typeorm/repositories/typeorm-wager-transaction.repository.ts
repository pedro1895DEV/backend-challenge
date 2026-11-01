import type { DataSource, EntityManager, Repository } from "typeorm";
import type { WagerTransactionRepository } from "../../../../application/ports/wager-transaction.repository";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from "../../../../domain/wagering/wager-transaction";
import { WagerTransactionMapper } from "../mappers/wager-transaction.mapper";
import {
  WagerTransactionEntitySchema,
  type WagerTransactionEntity,
} from "../schemas/wager-transaction.schema";

export class TypeOrmWagerTransactionRepository implements WagerTransactionRepository {
  private readonly repo: Repository<WagerTransactionEntity>;

  constructor(public readonly manager: DataSource | EntityManager) {
    this.repo = manager.getRepository(WagerTransactionEntitySchema);
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    const entity = await this.repo.findOneBy({ id });
    return entity ? WagerTransactionMapper.toDomain(entity) : null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.repo.findOneBy({ providerId, externalTransactionId });
    return entity ? WagerTransactionMapper.toDomain(entity) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    const entity = await this.repo.findOneBy({ idempotencyKey });
    return entity ? WagerTransactionMapper.toDomain(entity) : null;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    const entity = WagerTransactionMapper.toEntity(transaction);
    await this.repo.insert(entity);
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const entity = WagerTransactionMapper.toEntity(transaction);
    await this.repo.update({ id: entity.id }, entity);
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const entity = WagerTransactionMapper.toEntity(transaction);
    await this.repo.save(entity);
  }

  async findDuePendingReferences(now: Date, limit = 50): Promise<WagerTransaction[]> {
    const entities = await this.repo
      .createQueryBuilder("t")
      .where("t.status = :status", { status: WagerTransactionStatus.PendingReference })
      .andWhere("t.nextReferenceAttemptAt <= :now", { now })
      .orderBy("t.nextReferenceAttemptAt", "ASC")
      .take(limit)
      .getMany();

    return entities.map((e) => WagerTransactionMapper.toDomain(e));
  }

  async isReferenceAlreadyReversed(referenceTransactionId: string): Promise<boolean> {
    const count = await this.repo
      .createQueryBuilder("t")
      .where("t.referenceTransactionId = :referenceTransactionId", { referenceTransactionId })
      .andWhere("t.status = :status", { status: WagerTransactionStatus.Processed })
      .andWhere("t.kind IN (:...kinds)", {
        kinds: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback],
      })
      .getCount();

    return count > 0;
  }
}
