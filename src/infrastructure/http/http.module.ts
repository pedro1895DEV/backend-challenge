import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { METRICS_PORT, type MetricsPort } from "../../application/ports/metrics.port";
import {
  RECONCILIATION_OBSERVER,
  type ReconciliationObserver,
} from "../../application/ports/reconciliation-observer.port";
import { UNIT_OF_WORK, type UnitOfWork } from "../../application/ports/unit-of-work.port";
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from "../../application/ports/wager-transaction.repository";
import {
  WALLET_LEDGER_REPOSITORY,
  type WalletLedgerRepository,
} from "../../application/ports/wallet-ledger.repository";
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from "../../application/ports/wallet.repository";
import { GetWagerTransactionUseCase } from "../../application/use-cases/get-wager-transaction.use-case";
import { GetWalletUseCase } from "../../application/use-cases/get-wallet.use-case";
import { ListWalletLedgerUseCase } from "../../application/use-cases/list-wallet-ledger.use-case";
import { OpenWalletUseCase } from "../../application/use-cases/open-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../../application/use-cases/reconcile-wallet.use-case";
import { WageringController } from "./controllers/wagering.controller";
import { WalletsController } from "./controllers/wallets.controller";
import { GlobalHttpExceptionFilter } from "./filters/http-exception.filter";
import {
  GET_WAGER_TRANSACTION_USE_CASE,
  GET_WALLET_USE_CASE,
  LIST_WALLET_LEDGER_USE_CASE,
  OPEN_WALLET_USE_CASE,
  PROCESS_WAGER_TRANSACTION_USE_CASE,
  RECONCILE_WALLET_USE_CASE,
} from "./use-case.tokens";

@Module({
  controllers: [WalletsController, WageringController],
  providers: [
    {
      provide: OPEN_WALLET_USE_CASE,
      useFactory: (uow: UnitOfWork) => new OpenWalletUseCase(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: GET_WALLET_USE_CASE,
      useFactory: (walletRepo: WalletRepository) => new GetWalletUseCase(walletRepo),
      inject: [WALLET_REPOSITORY],
    },
    {
      provide: LIST_WALLET_LEDGER_USE_CASE,
      useFactory: (walletRepo: WalletRepository, ledgerRepo: WalletLedgerRepository) =>
        new ListWalletLedgerUseCase(walletRepo, ledgerRepo),
      inject: [WALLET_REPOSITORY, WALLET_LEDGER_REPOSITORY],
    },
    {
      provide: RECONCILE_WALLET_USE_CASE,
      useFactory: (
        uow: UnitOfWork,
        observer: ReconciliationObserver,
        metrics: MetricsPort,
      ) => new ReconcileWalletUseCase(uow, observer, metrics),
      inject: [UNIT_OF_WORK, RECONCILIATION_OBSERVER, METRICS_PORT],
    },
    {
      provide: PROCESS_WAGER_TRANSACTION_USE_CASE,
      useFactory: (
        uow: UnitOfWork,
        walletRepo: WalletRepository,
        txRepo: WagerTransactionRepository,
        metrics: MetricsPort,
      ) => new ProcessWagerTransactionUseCase(uow, walletRepo, txRepo, metrics),
      inject: [UNIT_OF_WORK, WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, METRICS_PORT],
    },
    {
      provide: GET_WAGER_TRANSACTION_USE_CASE,
      useFactory: (txRepo: WagerTransactionRepository) => new GetWagerTransactionUseCase(txRepo),
      inject: [WAGER_TRANSACTION_REPOSITORY],
    },
    {
      provide: APP_FILTER,
      useClass: GlobalHttpExceptionFilter,
    },
  ],
  exports: [
    OPEN_WALLET_USE_CASE,
    GET_WALLET_USE_CASE,
    LIST_WALLET_LEDGER_USE_CASE,
    RECONCILE_WALLET_USE_CASE,
    PROCESS_WAGER_TRANSACTION_USE_CASE,
    GET_WAGER_TRANSACTION_USE_CASE,
  ],
})
export class HttpApiModule {}
