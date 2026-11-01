import type { DataSource, EntityManager, Repository } from "typeorm";
import type {
  OutboxLagStats,
  OutboxRepository,
} from "../../../../application/ports/outbox.repository";
import type { OutboxMessage } from "../../../../domain/messaging/outbox-message";
import { OutboxMessageMapper } from "../mappers/outbox-message.mapper";
import {
  OutboxMessageEntitySchema,
  type OutboxMessageEntity,
} from "../schemas/outbox-message.schema";

export class TypeOrmOutboxRepository implements OutboxRepository {
  private readonly repo: Repository<OutboxMessageEntity>;

  constructor(public readonly manager: DataSource | EntityManager) {
    this.repo = manager.getRepository(OutboxMessageEntitySchema);
  }

  async findById(id: string): Promise<OutboxMessage | null> {
    const entity = await this.repo.findOneBy({ id });
    return entity ? OutboxMessageMapper.toDomain(entity) : null;
  }

  async findByAggregateId(aggregateId: string): Promise<OutboxMessage[]> {
    const entities = await this.repo.find({
      where: { aggregateId },
      order: { occurredAt: "ASC", id: "ASC" },
    });
    return entities.map((e) => OutboxMessageMapper.toDomain(e));
  }

  async insert(message: OutboxMessage): Promise<void> {
    const entity = OutboxMessageMapper.toEntity(message);
    await this.repo.insert(entity as Parameters<Repository<OutboxMessageEntity>["insert"]>[0]);
  }

  async insertMany(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const entities = messages.map((m) => OutboxMessageMapper.toEntity(m));
    await this.repo.insert(entities as Parameters<Repository<OutboxMessageEntity>["insert"]>[0]);
  }

  async update(message: OutboxMessage): Promise<void> {
    const entity = OutboxMessageMapper.toEntity(message);
    await this.repo.update(
      { id: entity.id },
      entity as Parameters<Repository<OutboxMessageEntity>["update"]>[1],
    );
  }

  async claimDueBatch(now: Date, limit = 50): Promise<OutboxMessage[]> {
    const entities = await this.repo
      .createQueryBuilder("o")
      .setLock("pessimistic_write")
      .setOnLocked("skip_locked")
      .where("o.publishedAt IS NULL")
      .andWhere("(o.nextAttemptAt IS NULL OR o.nextAttemptAt <= :now)", { now })
      .orderBy("o.occurredAt", "ASC")
      .addOrderBy("o.id", "ASC")
      .take(limit)
      .getMany();

    return entities.map((e) => OutboxMessageMapper.toDomain(e));
  }

  async countPending(): Promise<number> {
    return this.repo
      .createQueryBuilder("o")
      .where("o.publishedAt IS NULL")
      .getCount();
  }

  async getLagStats(now: Date = new Date()): Promise<OutboxLagStats> {
    const raw = await this.repo
      .createQueryBuilder("o")
      .select("COUNT(*)", "pendingCount")
      .addSelect("MIN(o.occurredAt)", "oldestOccurredAt")
      .where("o.publishedAt IS NULL")
      .getRawOne<{ pendingCount?: string | number; oldestOccurredAt?: string | Date | null }>();

    const pendingCount = Number(raw?.pendingCount ?? 0);
    if (pendingCount <= 0 || !raw?.oldestOccurredAt) {
      return { pendingCount: 0, oldestPendingAgeMs: 0 };
    }

    const oldestMs =
      raw.oldestOccurredAt instanceof Date
        ? raw.oldestOccurredAt.getTime()
        : new Date(raw.oldestOccurredAt).getTime();

    const oldestPendingAgeMs = Number.isFinite(oldestMs)
      ? Math.max(0, now.getTime() - oldestMs)
      : 0;

    return { pendingCount, oldestPendingAgeMs };
  }
}
