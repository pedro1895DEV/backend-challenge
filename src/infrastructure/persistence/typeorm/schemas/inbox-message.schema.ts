import { EntitySchema } from "typeorm";

export interface InboxMessageEntity {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date | null;
}

export const InboxMessageEntitySchema = new EntitySchema<InboxMessageEntity>({
  name: "InboxMessageEntity",
  tableName: "inbox_messages",
  columns: {
    consumerName: {
      type: "varchar",
      length: 64,
      primary: true,
      name: "consumer_name",
    },
    messageId: {
      type: "varchar",
      length: 128,
      primary: true,
      name: "message_id",
    },
    payloadHash: {
      type: "varchar",
      length: 64,
      name: "payload_hash",
    },
    receivedAt: {
      type: "timestamptz",
      name: "received_at",
    },
    processedAt: {
      type: "timestamptz",
      nullable: true,
      name: "processed_at",
    },
  },
});
