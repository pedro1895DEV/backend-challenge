import { EntitySchema } from "typeorm";

export interface WalletEntity {
  id: string;
  playerId: string;
  currency: string;
  balance: string; // decimal string
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletEntitySchema = new EntitySchema<WalletEntity>({
  name: "WalletEntity",
  tableName: "wallets",
  columns: {
    id: {
      type: "varchar",
      length: 36,
      primary: true,
    },
    playerId: {
      type: "varchar",
      length: 64,
      name: "player_id",
    },
    currency: {
      type: "char",
      length: 3,
    },
    balance: {
      type: "numeric",
      precision: 19,
      scale: 2,
    },
    version: {
      type: "int",
      default: 1,
    },
    createdAt: {
      type: "timestamptz",
      name: "created_at",
    },
    updatedAt: {
      type: "timestamptz",
      name: "updated_at",
    },
  },
  uniques: [
    {
      name: "uq_wallets_player_currency",
      columns: ["playerId", "currency"],
    },
  ],
});
