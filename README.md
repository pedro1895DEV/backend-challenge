# Distributed Wagering Processor 🦧

Processador financeiro distribuído de transações de apostas (*iGaming*) desenvolvido em **Bun 1.x**, **TypeScript estrito**, **NestJS**, **TypeORM (`EntitySchema`)**, **PostgreSQL 17** e **AWS SQS FIFO (MiniStack)**.

- 📄 **Decisões arquiteturais, algoritmos, diagramas e trade-offs:** [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- 📋 **Enunciado original completo do desafio:** [`docs/CHALLENGE.md`](./docs/CHALLENGE.md)

---

## Principais Garantias Implementadas

- **Precisão Monetária Estrita (`Money` sobre `BigInt` em centavos + `NUMERIC(19, 2)`):** nenhum `number`, `float` ou `double` para dinheiro em nenhuma camada (domínio, banco, contratos HTTP, eventos Outbox, logs ou métricas).
- **Concorrência por `walletId` em Múltiplas Instâncias (`>= 3` réplicas):** `READ COMMITTED` + `SELECT ... FOR UPDATE` escopado por carteira (zero lock global) e ordem canônica `wallets -> wager_transactions` livre de deadlocks.
- **Idempotência Persistente e Replay Fiel:** `Idempotency-Key` + `payloadHash` (`SHA-256` sobre JSON canônico dos campos de negócio), retornando o snapshot original de saldo/moeda (`idempotentReplay: true`) e `409 Conflict` em divergência de payload.
- **Ledger Estruturalmente Imutável e Reconciliação MVCC:** `WalletLedgerEntry` congelado (`Object.freeze`) + constraints `CHECK` aritméticas + trigger PostgreSQL `trg_ledger_immutable` bloqueando `UPDATE`/`DELETE` + auditoria `POST /wallets/:walletId/reconciliation` em snapshot `REPEATABLE READ` + `READ ONLY`.
- **Mensageria Atômica (SQS FIFO + Persistent Inbox + Transactional Outbox + DLQ):**
  - Consumer `wager-transactions.fifo` reutilizando o mesmo caso de uso do HTTP dentro da mesma transação SQL que `inbox_messages` e `outbox_messages`, com `DeleteMessage` (`ack`) estritamente pós-commit, roteamento determinístico para `wager-transactions-dlq.fifo` e graceful shutdown em `SIGTERM`.
  - `OutboxPublisherWorker` concorrente (`FOR UPDATE SKIP LOCKED`) publicando em `wager-events.fifo` com `eventId` estável.
  - `PendingReferenceWorker` com backoff exponencial (`1s → 5min`, máx. 10 tentativas) para `REFUND`/`ROLLBACK` entregues fora de ordem.
- **Observabilidade:** logs JSON estruturados com sanitização recursiva anti-vazamento financeiro/sensível, `GET /health/live`, `GET /health/ready` (PostgreSQL + SQS) e `GET /metrics` (Prometheus text & JSON).

---

## Pré-requisitos

- **Bun** `>= 1.1` (testado com `Bun 1.4.4`)
- **Docker** e **Docker Compose v2** (PostgreSQL 17 + MiniStack SQS)

---

## Setup e Execução Rápida

### 1. Instalar dependências e configurar `.env`

```bash
bun install
cp .env.example .env
```

*(No Windows PowerShell: `Copy-Item .env.example .env` — se `.env` já existir, este passo pode ser pulado.)*

### 2. Subir infraestrutura (PostgreSQL 17 + MiniStack SQS + provisionamento das filas FIFO/DLQ)

```bash
bun run infra:up
```

Este comando sobe `postgres` (porta `5432`) e `sqs` (MiniStack na porta `4566`), aguarda os healthchecks e executa o container `sqs-init`, criando `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (com *RedrivePolicy* `maxReceiveCount=5`) e `wager-events.fifo`.

### 3. Opção A — Rodar a aplicação localmente com Bun

```bash
# Produção / execução padrão (migrations rodam automaticamente no boot sob pg_advisory_lock)
bun start

# Modo desenvolvimento com hot-reload
bun run dev
```

A API estará disponível em `http://localhost:3000`.

### 4. Opção B — Subir o cluster completo com 3 réplicas da aplicação em containers Docker

```bash
bun run app:up
```

Sobe **3 containers simultâneos** da aplicação (`--scale app=3`) mapeados no host na faixa `http://localhost:3000`, `http://localhost:3001` e `http://localhost:3002`. Para encerrar as réplicas:

```bash
bun run app:down
```

---

## Comandos de Verificação, Testes e Carga

> Certifique-se de que `bun run infra:up` esteja ativo antes de rodar os testes de integração/e2e/carga (eles utilizam PostgreSQL 17 e MiniStack SQS **reais**, sem mocks de banco ou fila).

| Comando | Descrição |
|---|---|
| `bun run typecheck` | Verificação estática completa do TypeScript (`tsc --noEmit`, `strict: true`). |
| `bun test` | Executa **toda** a suíte automatizada (**200 testes em 18 arquivos**: unidade, banco/constraints, atomicidade Inbox/Outbox, mensageria SQS/DLQ/SIGTERM, concorrência real com 3 processos SO, API HTTP e observabilidade). |
| `bun run test:unit` | Executa apenas os testes unitários puros de domínio, config, HTTP filter e observabilidade (sem depender de containers). |
| `bun run test:e2e` | Executa os testes end-to-end HTTP, health checks e métricas/logs contra PostgreSQL e SQS reais. |
| `bun run test:load` | Sobe automaticamente 3 instâncias reais (ou usa `LOAD_TEST_URLS=http://localhost:3000,http://localhost:3001,http://localhost:3002`) e executa o benchmark multi-wallet + hot-wallet + auditoria contábil de reconciliação. |
| `bun run infra:down` | Para os containers de infraestrutura mantendo volumes. |
| `bun run infra:reset` | Para os containers e remove volumes persistentes (`docker compose down -v`). |

---

## Exemplos de Uso da API HTTP

### 1. Health Checks e Métricas (`@Public()`)

```bash
curl -s http://localhost:3000/health/live
curl -s http://localhost:3000/health/ready

# Formato Prometheus (default)
curl -s http://localhost:3000/metrics

# Snapshot JSON estruturado
curl -s "http://localhost:3000/metrics?format=json"
```

### 2. Abrir uma Wallet (`201 Created`)

```bash
curl -i -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -H "X-Correlation-Id: demo-open-001" \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'
```

### 3. Submeter uma Transação de Aposta (`200 OK` / `422` / `202` / `409`)

```bash
curl -i -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:transaction-123" \
  -H "X-Correlation-Id: demo-bet-001" \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<WALLET_ID>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

Repetir exatamente a mesma chamada retorna `200 OK` com `"idempotentReplay": true` e o saldo observado no momento da liquidação original.

### 4. Consultar Wallet, Ledger Paginado (Cursor Opaco) e Transações

```bash
curl -s http://localhost:3000/wallets/<WALLET_ID>
curl -s "http://localhost:3000/wallets/<WALLET_ID>/ledger?limit=20"
curl -s http://localhost:3000/wagering/transactions/<TRANSACTION_ID>
curl -s http://localhost:3000/providers/provider-a/wagering/transactions/transaction-123
```

### 5. Reconciliar Saldo Materializado vs Ledger (`200 OK`)

```bash
curl -s -X POST http://localhost:3000/wallets/<WALLET_ID>/reconciliation
```

---

## Variáveis de Ambiente Principais (`.env.example`)

| Variável | Default | Descrição |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` ou `production`. |
| `PORT` | `3000` | Porta HTTP da instância. |
| `DB_HOST` / `DB_PORT` | `localhost` / `5432` | Host e porta do PostgreSQL 17. |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `wagering` / `wagering` / `wagering` | Credenciais e database PostgreSQL. |
| `AWS_REGION` | `us-east-1` | Região configurada para o cliente SQS. |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | Endpoint do MiniStack / LocalStack (`http://sqs:4566` dentro da rede Docker; omitir para AWS real). |
| `SQS_QUEUE_NAME` | `wager-transactions.fifo` | Fila FIFO principal de entrada de apostas. |
| `SQS_DLQ_NAME` | `wager-transactions-dlq.fifo` | Dead-Letter Queue FIFO de entrada. |
| `SQS_OUTBOX_QUEUE_NAME` | `wager-events.fifo` | Fila FIFO de destino dos eventos publicados pelo Outbox. |
| `SQS_CONSUMER_ENABLED` | `true` | Habilita/desabilita o long-polling automático do consumer SQS. |
| `OUTBOX_POLL_INTERVAL_MS` | `250` | Intervalo de polling do `OutboxPublisherWorker` (`0` desativa timer automático). |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | `250` | Intervalo de varredura do `PendingReferenceWorker` (`0` desativa timer automático). |

---

## Estrutura do Projeto

```text
├── docker/
│   └── sqs-init.sh                  # Provisionamento das filas FIFO e RedrivePolicy no MiniStack
├── docs/
│   └── CHALLENGE.md                 # Especificação original integral do desafio Jungle Gaming
├── scripts/
│   └── load-test.ts                 # Benchmark multi-instância (bun run test:load)
├── src/
│   ├── config/                      # Validação fail-fast de variáveis de ambiente
│   ├── domain/                      # Core DDD puro (zero imports de NestJS/TypeORM/AWS)
│   │   ├── messaging/               # InboxMessage, OutboxMessage, IntegrationEvent e subclasses
│   │   ├── money/                   # Value Object Money (BigInt em centavos, imutável)
│   │   ├── shared/                  # Erros de domínio e gerador UUIDv7 monotônico
│   │   ├── wagering/                # WagerTransaction, FailureCode, payloadHash, liquidação e retry policy
│   │   └── wallet/                  # Aggregate Root Wallet e WalletLedgerEntry imutável
│   ├── application/                 # Casos de uso e portas puras (HTTP + SQS compartilham liquidação)
│   │   ├── errors/                  # Erros semânticos de aplicação
│   │   ├── ports/                   # UnitOfWork, Repositories, EventPublisher, ProviderIdentity, Metrics
│   │   ├── shared/                  # Validação estrita de contratos e factory de eventos Outbox
│   │   └── use-cases/               # Open/Get/Ledger/Reconcile Wallet, Process/Get/Consume Wager, Outbox, PendingRef
│   ├── health/                      # GET /health/live e GET /health/ready
│   └── infrastructure/              # Adaptadores NestJS, TypeORM, AWS SQS, Workers e Observabilidade
│       ├── http/                    # Controllers, AuthGuard + ProviderIdentityPort, GlobalHttpExceptionFilter
│       ├── messaging/sqs/           # SqsService e SqsEventPublisherAdapter
│       ├── observability/           # StructuredJsonLogger, MetricsRegistry, GET /metrics, ReconciliationObserver
│       ├── persistence/typeorm/     # EntitySchemas, Mappers, Migrations reversíveis, UnitOfWork e Repositórios
│       └── workers/                 # SqsWagerConsumerWorker, OutboxPublisherWorker, PendingReferenceWorker
├── test/
│   ├── unit/                        # Testes unitários de domínio, config, HTTP filter e observabilidade
│   ├── integration/
│   │   ├── database/                # Constraints PostgreSQL, triggers append-only e atomicidade transacional
│   │   ├── concurrency/             # Paralelismo real com >= 3 processos SO independentes e crash/restart
│   │   └── messaging/               # SQS FIFO + Inbox + Outbox + DLQ + SIGTERM contra MiniStack real
│   └── e2e/                         # Contratos HTTP completos, health checks e observabilidade/métricas
├── ARCHITECTURE.md                  # Documento completo de arquitetura, decisões e trade-offs
├── Dockerfile                       # Build multi-stage com Bun 1.4-alpine
└── docker-compose.yml               # PostgreSQL 17 + MiniStack SQS + perfil --scale app=3
```
