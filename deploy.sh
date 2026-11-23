
#!/bin/bash

# Exit immediately if a command fails
set -e

# -----------------------------
# Configuration
# -----------------------------
PM2_APP_NAME="trader-hunt"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=========================================="
CURRENT_BRANCH=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD)
echo "Starting deployment"
echo "Branch : $CURRENT_BRANCH"
echo "Project: $PROJECT_DIR"
echo "=========================================="

# -----------------------------
# Step 1 - Pull latest code
# -----------------------------
echo "🚀 Step 1: Pulling latest changes..."
cd "$PROJECT_DIR"
git pull origin "$CURRENT_BRANCH"

# -----------------------------
# Step 2 - Install dependencies
# -----------------------------
echo "📦 Step 2: Installing dependencies..."

if [ -f package-lock.json ]; then
    npm ci
elif [ -f package.json ]; then
    npm install
else
    echo "No package.json found. Skipping dependency installation."
fi

# -----------------------------
# Step 3 - Restart PM2
# -----------------------------
echo "🚀 Step 3: Restarting PM2..."

if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
    echo "Reloading existing PM2 process..."
    pm2 restart "$PM2_APP_NAME"
else
    echo "PM2 process not found!"
    echo "Please start the application manually once:"
    echo "pm2 start <your-entry-file> --name $PM2_APP_NAME"
    exit 1
fi

# -----------------------------
# Step 4 - Save PM2 process list
# -----------------------------
pm2 save

echo "=========================================="
echo "✅ Deployment completed successfully!"
echo "=========================================="

echo ""
echo "Application Status:"
pm2 status "$PM2_APP_NAME"
