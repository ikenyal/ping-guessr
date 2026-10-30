#!/usr/bin/env bash
# Build and deploy to AWS Amplify Hosting (manual deployment, no Git connection).
# Usage: AMPLIFY_APP_ID=<app id> ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${AMPLIFY_APP_ID:?set AMPLIFY_APP_ID}"
REGION="${AWS_REGION:-ap-northeast-1}"
BRANCH="${AMPLIFY_BRANCH:-main}"
npx vite build
zip_file=$(mktemp -d)/site.zip
(cd dist && zip -qr "$zip_file" .)
d=$(aws amplify create-deployment --region "$REGION" --app-id "$AMPLIFY_APP_ID" --branch-name "$BRANCH" --output json)
job=$(echo "$d" | jq -r .jobId)
curl -sf -T "$zip_file" "$(echo "$d" | jq -r .zipUploadUrl)"
aws amplify start-deployment --region "$REGION" --app-id "$AMPLIFY_APP_ID" --branch-name "$BRANCH" --job-id "$job" >/dev/null
for _ in $(seq 1 30); do
  s=$(aws amplify get-job --region "$REGION" --app-id "$AMPLIFY_APP_ID" --branch-name "$BRANCH" --job-id "$job" --query job.summary.status --output text)
  echo "$s"
  case "$s" in SUCCEED) break ;; FAILED|CANCELLED) exit 1 ;; esac
  sleep 5
done
echo "https://$BRANCH.$AMPLIFY_APP_ID.amplifyapp.com"
