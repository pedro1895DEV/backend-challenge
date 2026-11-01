#!/bin/sh
# Creates the SQS FIFO queues and DLQ (README §10 & §11). Strictly idempotent: safe to re-run
# even if queues were previously auto-created with default retention/visibility attributes.
set -eu

ENDPOINT="${AWS_ENDPOINT_URL:-http://sqs:4566}"
QUEUE="${SQS_QUEUE_NAME:-wager-transactions.fifo}"
DLQ="${SQS_DLQ_NAME:-wager-transactions-dlq.fifo}"
OUTBOX_QUEUE="${SQS_OUTBOX_QUEUE_NAME:-wager-events.fifo}"
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-5}"
VISIBILITY_TIMEOUT="${SQS_VISIBILITY_TIMEOUT_SECONDS:-30}"

sqs() { aws --endpoint-url "$ENDPOINT" sqs "$@"; }

ensure_fifo_queue() {
  q_name="$1"
  q_create_attrs="$2"
  if q_existing=$(sqs get-queue-url --queue-name "$q_name" --query QueueUrl --output text 2>/dev/null) && [ -n "$q_existing" ] && [ "$q_existing" != "None" ]; then
    echo "$q_existing"
  else
    sqs create-queue --queue-name "$q_name" --attributes "$q_create_attrs" --query QueueUrl --output text
  fi
}

echo "[sqs-init] waiting for SQS at $ENDPOINT ..."
attempt=0
until sqs list-queues >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "[sqs-init] SQS not reachable after 60s" >&2
    exit 1
  fi
  sleep 1
done

echo "[sqs-init] ensuring DLQ $DLQ"
DLQ_URL=$(ensure_fifo_queue "$DLQ" "FifoQueue=true,MessageRetentionPeriod=1209600")
sqs set-queue-attributes --queue-url "$DLQ_URL" --attributes MessageRetentionPeriod=1209600 >/dev/null
DLQ_ARN=$(sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

cat > /tmp/queue-create-attributes.json <<EOF
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "$VISIBILITY_TIMEOUT",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"$MAX_RECEIVE_COUNT\"}"
}
EOF

cat > /tmp/queue-mutable-attributes.json <<EOF
{
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "$VISIBILITY_TIMEOUT",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"$MAX_RECEIVE_COUNT\"}"
}
EOF

echo "[sqs-init] ensuring queue $QUEUE (DLQ after $MAX_RECEIVE_COUNT receives)"
QUEUE_URL=$(ensure_fifo_queue "$QUEUE" "file:///tmp/queue-create-attributes.json")
sqs set-queue-attributes --queue-url "$QUEUE_URL" --attributes file:///tmp/queue-mutable-attributes.json >/dev/null

echo "[sqs-init] ensuring outbox events queue $OUTBOX_QUEUE"
OUTBOX_URL=$(ensure_fifo_queue "$OUTBOX_QUEUE" "FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600")
sqs set-queue-attributes --queue-url "$OUTBOX_URL" --attributes ContentBasedDeduplication=false,MessageRetentionPeriod=1209600 >/dev/null

echo "[sqs-init] ready:"
echo "  queue:  $QUEUE_URL"
echo "  dlq:    $DLQ_URL ($DLQ_ARN)"
echo "  outbox: $OUTBOX_URL"
