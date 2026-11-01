import type { MoneyProps } from "../../domain/money/money";
import type { LedgerDirection } from "../../domain/wallet/wallet-ledger-entry";
import { ValidationError, WalletNotFoundError } from "../errors/application-errors";
import type { WalletLedgerRepository } from "../ports/wallet-ledger.repository";
import type { WalletRepository } from "../ports/wallet.repository";
import { requireNonEmptyString } from "../shared/validation";

export interface ListWalletLedgerInput {
  walletId: unknown;
  cursor?: unknown;
  limit?: unknown;
}

export interface LedgerEntryOutput {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface ListWalletLedgerOutput {
  walletId: string;
  items: LedgerEntryOutput[];
  nextCursor: string | null;
}

export class ListWalletLedgerUseCase {
  constructor(
    private readonly walletRepo: WalletRepository,
    private readonly ledgerRepo: WalletLedgerRepository,
  ) {}

  async execute(input: ListWalletLedgerInput): Promise<ListWalletLedgerOutput> {
    const walletId = requireNonEmptyString(input.walletId, "walletId", 64);
    const limit = this.parseLimit(input.limit);
    const cursor = this.parseCursor(input.cursor);

    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    const page = await this.ledgerRepo.findByWalletId(walletId, { cursor, limit });

    return {
      walletId,
      items: page.entries.map((entry) => ({
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor ?? null,
    };
  }

  private parseLimit(raw: unknown): number {
    if (raw === undefined || raw === null || raw === "") return 50;
    const str = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
    if (!/^\d+$/.test(str)) {
      throw new ValidationError("limit must be an integer between 1 and 100", "INVALID_QUERY_PARAM");
    }
    const parsed = Number(str);
    if (parsed < 1 || parsed > 100) {
      throw new ValidationError("limit must be an integer between 1 and 100", "INVALID_QUERY_PARAM");
    }
    return parsed;
  }

  private parseCursor(raw: unknown): string | undefined {
    if (raw === undefined || raw === null || raw === "") return undefined;
    if (typeof raw !== "string") {
      throw new ValidationError("Invalid pagination cursor", "INVALID_CURSOR");
    }
    return raw.trim();
  }
}
