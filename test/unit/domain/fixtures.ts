import { Money } from "../../../src/domain/money/money";
import { Wallet } from "../../../src/domain/wallet/wallet";
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
  type SubmittableKind,
} from "../../../src/domain/wagering/wager-transaction";
import { computeWagerPayloadHash } from "../../../src/domain/wagering/payload-hash";

export const NOW = new Date("2026-07-29T15:00:00.000Z");
export const PLAYER_ID = "player-1";
export const WALLET_ID = "wallet-1";
export const PROVIDER_ID = "provider-a";
export const ROUND_ID = "round-987";

export const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });

let sequence = 0;
export const nextId = (prefix = "id"): string => `${prefix}-${++sequence}`;

export function openWallet(balance = "100.00", overrides: { id?: string; playerId?: string } = {}): Wallet {
  const initialBalance = brl(balance);
  return Wallet.open({
    id: overrides.id ?? WALLET_ID,
    playerId: overrides.playerId ?? PLAYER_ID,
    initialBalance,
    at: NOW,
    opening: initialBalance.isPositive()
      ? { transactionId: nextId("opening-tx"), ledgerEntryId: nextId("entry") }
      : undefined,
  }).wallet;
}

export function wager(
  kind: SubmittableKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId("ext");
  const money = overrides.money ?? brl(amount);
  const base = {
    providerId: PROVIDER_ID,
    externalTransactionId,
    playerId: PLAYER_ID,
    walletId: WALLET_ID,
    roundId: ROUND_ID,
    gameId: "fortune-chimp",
    kind,
    ...overrides,
    money,
  };
  return WagerTransaction.create({
    id: nextId("tx"),
    idempotencyKey: `${base.providerId}:${externalTransactionId}`,
    payloadHash: computeWagerPayloadHash({ ...base, money: money.toJSON() }),
    createdAt: NOW,
    ...base,
  });
}

export const { Bet, Win, Loss, Refund, Rollback } = {
  Bet: WagerTransactionKind.Bet,
  Win: WagerTransactionKind.Win,
  Loss: WagerTransactionKind.Loss,
  Refund: WagerTransactionKind.Refund,
  Rollback: WagerTransactionKind.Rollback,
} as const;
