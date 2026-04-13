#!/bin/bash
# reset.sh — 节点重启后一键重置
# 用法: bash scripts/reset.sh
set -e

echo "📦 Deploying contracts..."
npx hardhat run scripts/deploy.js --network localhost

echo "⛏  Mining blocks to flush MetaMask block cache..."
for i in {1..6}; do
  curl -s -X POST http://127.0.0.1:8545 -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"method\":\"hardhat_mine\",\"params\":[\"0x1\"],\"id\":$i}" > /dev/null
done

BLOCK=$(curl -s -X POST http://127.0.0.1:8545 -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":99}' | \
  python3 -c "import json,sys; print(int(json.load(sys.stdin)['result'],16))")

echo "✅ Done. Current block: $BLOCK"
echo ""
echo "👉 Last step: MetaMask → Settings → Advanced → Clear activity and nonce data"
