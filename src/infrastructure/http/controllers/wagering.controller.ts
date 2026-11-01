import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { ValidationError } from "../../../application/errors/application-errors";
import type {
  GetWagerTransactionUseCase,
  WagerTransactionDetailsOutput,
} from "../../../application/use-cases/get-wager-transaction.use-case";
import type {
  ProcessWagerTransactionOutput,
  ProcessWagerTransactionUseCase,
} from "../../../application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionStatus } from "../../../domain/wagering/wager-transaction";
import { assertCallerMatchesProvider, type AuthenticatedRequest } from "../auth/auth.guard";
import { resolveCorrelationId, type MinimalHttpResponse } from "../correlation-id";
import {
  GET_WAGER_TRANSACTION_USE_CASE,
  PROCESS_WAGER_TRANSACTION_USE_CASE,
} from "../use-case.tokens";

@Controller()
export class WageringController {
  private readonly logger = new Logger("WageringController");

  constructor(
    @Inject(PROCESS_WAGER_TRANSACTION_USE_CASE)
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    @Inject(GET_WAGER_TRANSACTION_USE_CASE)
    private readonly getWagerTxUseCase: GetWagerTransactionUseCase,
  ) {}

  @Post("wagering/transactions")
  async submitTransaction(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: MinimalHttpResponse,
  ): Promise<ProcessWagerTransactionOutput> {
    const startedAt = performance.now();
    const correlationId = resolveCorrelationId(req.headers ?? {}, res);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("Request body must be a JSON object");
    }

    const rawIdempotencyKey = req.headers?.["idempotency-key"];
    if (Array.isArray(rawIdempotencyKey) && rawIdempotencyKey.length > 1) {
      throw new ValidationError(
        "Multiple Idempotency-Key headers are not allowed",
        "INVALID_IDEMPOTENCY_KEY",
      );
    }
    const idempotencyKey = Array.isArray(rawIdempotencyKey)
      ? rawIdempotencyKey[0]
      : rawIdempotencyKey;

    const payload = body as Record<string, unknown>;
    assertCallerMatchesProvider(req.caller, payload.providerId);

    const result = await this.processWagerUseCase.execute({
      idempotencyKey,
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      playerId: payload.playerId,
      walletId: payload.walletId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: payload.money,
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
      correlationId,
    });

    this.logger.log(
      JSON.stringify({
        event: result.idempotentReplay
          ? "wager_transaction_replayed"
          : "wager_transaction_settled",
        channel: "http",
        correlationId,
        messageId: null,
        transactionId: result.transactionId,
        walletId: typeof payload.walletId === "string" ? payload.walletId.trim() : null,
        providerId: typeof payload.providerId === "string" ? payload.providerId.trim() : null,
        kind: typeof payload.kind === "string" ? payload.kind.trim() : null,
        status: result.status,
        failureCode: result.failureCode ?? null,
        idempotentReplay: result.idempotentReplay,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      }),
    );

    res.status(mapWagerStatusToHttpStatus(result.status));
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  async getTransactionById(
    @Param("transactionId") transactionId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: MinimalHttpResponse,
  ): Promise<WagerTransactionDetailsOutput> {
    resolveCorrelationId(req.headers ?? {}, res);
    const tx = await this.getWagerTxUseCase.getById(transactionId);
    assertCallerMatchesProvider(req.caller, tx.providerId);
    return tx;
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getTransactionByProviderExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: MinimalHttpResponse,
  ): Promise<WagerTransactionDetailsOutput> {
    resolveCorrelationId(req.headers ?? {}, res);
    assertCallerMatchesProvider(req.caller, providerId);
    return this.getWagerTxUseCase.getByProviderAndExternalId(providerId, externalTransactionId);
  }
}

export function mapWagerStatusToHttpStatus(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return HttpStatus.OK; // 200
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return HttpStatus.ACCEPTED; // 202
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY; // 422
    case WagerTransactionStatus.Failed:
      return HttpStatus.INTERNAL_SERVER_ERROR; // 500
  }
}
