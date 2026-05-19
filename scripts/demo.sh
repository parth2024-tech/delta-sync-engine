#!/usr/bin/env bash
set -e

echo "==========================================="
echo " Delta Sync Engine — Lite Mode Demo"
echo "==========================================="
echo ""
echo "Starting Docker Compose (Node.js API + MinIO S3)..."
echo ""

# Ensure we're in the project root
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR/.."

# Build and bring up the containers
docker-compose -f docker-compose.lite.yml up --build -d

echo ""
echo "Services are starting!"
echo " - API Server: http://localhost:5000"
echo " - MinIO Console: http://localhost:9001 (minioadmin / minioadmin)"
echo ""
echo "To view logs, run: docker-compose -f docker-compose.lite.yml logs -f"
echo "To stop the demo, run: docker-compose -f docker-compose.lite.yml down"
echo ""
