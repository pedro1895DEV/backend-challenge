import type { DataSource, EntityManager, Repository } from "typeorm";
import { ValidationError } from "../../../../application/errors/application-errors";
import type {
  LedgerPaginationOptions,
  PaginatedLedgerEntries,
  WalletLedgerRepository,
} from "../../../../application/ports/wallet-ledger.repository";
import { Money } from "../../../../domain/money/money";
import type { WalletLedgerEntry } from "../../../../domain/wallet/wallet-ledger-entry";
import { WalletLedgerEntryMapper } from "../mappers/wallet-ledger-entry.mapper";
import {
  WalletLedgerEntryEntitySchema,
  type WalletLedgerEntryEntity,
} from "../schemas/wallet-ledger-entry.schema";

interface DecodedCursor {
  createdAt: Date;
  id: string;
}

export class TypeOrmWalletLedgerRepository implements WalletLedgerRepository {
  private readonly repo: Repository<WalletLedgerEntryEntity>;

  constructor(public readonly manager: DataSource | EntityManager) {
    this.repo = manager.getRepository(WalletLedgerEntryEntitySchema);
  }

  async insert(entry: WalletLedgerEntry): Promise<void> {
    const entity = WalletLedgerEntryMapper.toEntity(entry);
    await this.repo.insert(entity);
  }

  async save(entry: WalletLedgerEntry): Promise<void> {
    await this.insert(entry);
  }

  async findByWalletId(
    walletId: string,
    options: LedgerPaginationOptions = {},
  ): Promise<PaginatedLedgerEntries> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const cursor = options.cursor !== undefined ? this.decodeCursor(options.cursor) : null;

    const qb = this.repo
      .createQueryBuilder("e")
      .where("e.walletId = :walletId", { walletId })
      .orderBy("e.createdAt", "DESC")
      .addOrderBy("e.id", "DESC")
      .take(limit + 1);

    if (cursor) {
      qb.andWhere("(e.createdAt < :cursorDate OR (e.createdAt = :cursorDate AND e.id < :cursorId))", {
        cursorDate: cursor.createdAt,
        cursorId: cursor.id,
      });
    }

    const [entities, totalCount] = await Promise.all([
      qb.getMany(),
      this.repo.countBy({ walletId }),
    ]);

    const hasNext = entities.length > limit;
    const pagedEntities = hasNext ? entities.slice(0, limit) : entities;
    const entries = pagedEntities.map((e) => WalletLedgerEntryMapper.toDomain(e));

    let nextCursor: string | undefined;
    if (hasNext && pagedEntities.length > 0) {
      const last = pagedEntities[pagedEntities.length - 1];
      if (last) {
        nextCursor = this.encodeCursor(last.createdAt, last.id);
      }
    }

    return { entries, nextCursor, totalCount };
  }

  async calculateBalance(walletId: string, currency: string): Promise<{ balance: Money; count: number }> {
    const raw = await this.repo
      .createQueryBuilder("e")
      .select(
        "COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0.00)::NUMERIC(19, 2)::TEXT",
        "sum",
      )
      .addSelect("COUNT(e.id)::TEXT", "count")
      .where("e.walletId = :walletId", { walletId })
      .getRawOne<{ sum: string; count: string }>();

    const amount = raw?.sum ?? "0.00";
    const count = raw?.count ? parseInt(raw.count, 10) : 0;

    return {
      balance: Money.fromSigned({ amount, currency }),
      count,
    };
  }

  private encodeCursor(createdAt: Date, id: string): string {
    const payload = JSON.stringify({ t: createdAt.toISOString(), id });
    return Buffer.from(payload, "utf-8").toString("base64url");
  }

  private decodeCursor(cursor: string): DecodedCursor {
    if (!cursor || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new ValidationError("Invalid pagination cursor", "INVALID_CURSOR");
    }

    let parsed: unknown;
    try {
      const json = Buffer.from(cursor, "base64url").toString("utf-8");
      parsed = JSON.parse(json);
    } catch {
      throw new ValidationError("Invalid pagination cursor", "INVALID_CURSOR");
    }

    if (!parsed || typeof parsed !== "object") {
      throw new ValidationError("Invalid pagination cursor", "INVALID_CURSOR");
    }

    const { t, id } = parsed as { t?: unknown; id?: unknown };
    if (typeof t !== "string" || typeof id !== "string" || id.trim() === "") {
      throw new ValidationError("Invalid pagination cursor", "INVALID_CURSOR");
    }

    const createdAt = new Date(t);
    if (Number.isNaN(createdAt.getTime())) {
      throw new ValidationError("Invalid pagination cursor", "INVALID_CURSOR");
    }

    return { createdAt, id };
  }
}
