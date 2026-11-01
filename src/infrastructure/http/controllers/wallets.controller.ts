import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ValidationError } from "../../../application/errors/application-errors";
import type { GetWalletUseCase, WalletDetailsOutput } from "../../../application/use-cases/get-wallet.use-case";
import type {
  ListWalletLedgerOutput,
  ListWalletLedgerUseCase,
} from "../../../application/use-cases/list-wallet-ledger.use-case";
import type { OpenWalletOutput, OpenWalletUseCase } from "../../../application/use-cases/open-wallet.use-case";
import type {
  ReconcileWalletOutput,
  ReconcileWalletUseCase,
} from "../../../application/use-cases/reconcile-wallet.use-case";
import type { AuthenticatedRequest } from "../auth/auth.guard";
import { resolveCorrelationId, type MinimalHttpResponse } from "../correlation-id";
import {
  GET_WALLET_USE_CASE,
  LIST_WALLET_LEDGER_USE_CASE,
  OPEN_WALLET_USE_CASE,
  RECONCILE_WALLET_USE_CASE,
} from "../use-case.tokens";

@Controller("wallets")
export class WalletsController {
  private readonly logger = new Logger("WalletsController");

  constructor(
    @Inject(OPEN_WALLET_USE_CASE)
    private readonly openWalletUseCase: OpenWalletUseCase,
    @Inject(GET_WALLET_USE_CASE)
    private readonly getWalletUseCase: GetWalletUseCase,
    @Inject(LIST_WALLET_LEDGER_USE_CASE)
    private readonly listWalletLedgerUseCase: ListWalletLedgerUseCase,
    @Inject(RECONCILE_WALLET_USE_CASE)
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async openWallet(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: MinimalHttpResponse,
  ): Promise<OpenWalletOutput> {
    const correlationId = resolveCorrelationId(req.headers ?? {}, res);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("Request body must be a JSON object");
    }
    const payload = body as Record<string, unknown>;
    const opened = await this.openWalletUseCase.execute({
      playerId: payload.playerId,
      initialBalance: payload.initialBalance,
      correlationId,
    });

    this.logger.log(
      JSON.stringify({
        event: "wallet_opened",
        correlationId,
        messageId: null,
        transactionId: null,
        walletId: opened.id,
        providerId: null,
        currency: opened.balance.currency,
        version: opened.version,
      }),
    );

    return opened;
  }

  @Get(":walletId")
  async getWallet(
    @Param("walletId") walletId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: MinimalHttpResponse,
  ): Promise<WalletDetailsOutput> {
    resolveCorrelationId(req.headers ?? {}, res);
    return this.getWalletUseCase.execute(walletId);
  }

  @Get(":walletId/ledger")
  async listLedger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: MinimalHttpResponse,
  ): Promise<ListWalletLedgerOutput> {
    resolveCorrelationId(req.headers ?? {}, res);
    return this.listWalletLedgerUseCase.execute({ walletId, cursor, limit });
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  async reconcileWallet(
    @Param("walletId") walletId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: MinimalHttpResponse,
  ): Promise<ReconcileWalletOutput> {
    const correlationId = resolveCorrelationId(req.headers ?? {}, res);
    const result = await this.reconcileWalletUseCase.execute({ walletId, correlationId });

    this.logger.log(
      JSON.stringify({
        event: "wallet_reconciled",
        correlationId,
        messageId: null,
        transactionId: null,
        walletId: result.walletId,
        providerId: null,
        consistent: result.consistent,
        checkedEntries: result.checkedEntries,
      }),
    );

    return result;
  }
}
