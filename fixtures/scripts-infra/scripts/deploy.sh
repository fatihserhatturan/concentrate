#!/bin/bash
set -e
STAGE=${DEPLOY_STAGE:-staging}
export REGISTRY="registry.example.com"
export APP_VERSION
count=0
for f in scripts/*.sh; do
  echo "$f" "$count"
done
echo "Deploying $STAGE to $REGISTRY with $API_TOKEN, $1, $@, $HOME"
echo 'not $EXPANDED'
# $COMMENTED
cat <<'EOF2'
$HEREDOC_QUOTED
EOF2
cat <<EOF3
$HEREDOC_OPEN
EOF3
DATABASE_URL=postgres://x ./scripts/migrate.sh
./scripts/build.sh && make test
