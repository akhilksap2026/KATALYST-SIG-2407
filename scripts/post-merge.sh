#!/bin/bash
set -e

# Install Node.js dependencies (non-interactive, safe to re-run)
npm install --prefer-offline 2>/dev/null || npm install

echo "Post-merge setup complete."
