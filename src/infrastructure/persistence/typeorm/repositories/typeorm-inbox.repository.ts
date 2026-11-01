import type { DataSource, EntityManager, Repository } from "typeorm";
import type { InboxRepository } from "../../../../application/ports/inbox.repository";
import type { InboxMessage } from "../../../../domain/messaging/inbox-message";
import { InboxMessageMapper } from "../mappers/inbox-message.mapper";
import {
  InboxMessageEntitySchema,
  type InboxMessageEntity,
} from "../schemas/inbox-message.schema";

export class TypeOrmInboxRepository implements InboxRepository {
  private readonly repo: Repository<InboxMessageEntity>;

  constructor(public readonly manager: DataSource | EntityManager) {
    this.repo = manager.getRepository(InboxMessageEntitySchema);
  }

  async findByConsumerAndMessageId(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null> {
    const entity = await this.repo.findOneBy({ consumerName, messageId });
    return entity ? InboxMessageMapper.toDomain(entity) : null;
  }

  async insert(message: InboxMessage): Promise<void> {
    const entity = InboxMessageMapper.toEntity(message);
    await this.repo.insert(entity);
  }

  async update(message: InboxMessage): Promise<void> {
    const entity = InboxMessageMapper.toEntity(message);
    await this.repo.update(
      { consumerName: entity.consumerName, messageId: entity.messageId },
      entity,
    );
  }
}
