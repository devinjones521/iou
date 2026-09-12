#!/usr/bin/env bash
#
# Install IOU as a systemd service. Run ON THE BOX as root.
#
#   curl -fsSL https://raw.githubusercontent.com/devinjones521/iou/main/deploy/install.sh | bash
#
# or, having copied the repo across:  sudo bash deploy/install.sh
#
# It does NOT create or hold any secret. It creates /etc/iou/iou.env with placeholders, mode 600,
# and stops. You fill it in and start the service. Nothing here ever writes a key to disk for you,
# echoes one, or reads one from the environment — so nothing can leak one into a shell history,
# a log, or a screen share.
set -euo pipefail

REPO="${IOU_REPO_URL:-https://github.com/devinjones521/iou.git}"
DIR=/opt/iou
ENVDIR=/etc/iou
USER=iou

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
command -v node >/dev/null || { echo "node is not installed — install Node 22+ first"; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[[ "$NODE_MAJOR" -ge 22 ]] || { echo "node $NODE_MAJOR is too old; IOU needs 22+"; exit 1; }

echo "==> dedicated service account (no shell, no home, owns nothing else)"
id -u "$USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$USER"

echo "==> code at $DIR"
if [[ -d "$DIR/.git" ]]; then
  git -C "$DIR" fetch --quiet origin && git -C "$DIR" reset --hard --quiet origin/main
else
  rm -rf "$DIR"; git clone --quiet "$REPO" "$DIR"
fi
( cd "$DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null )
install -d -o "$USER" -g "$USER" -m 750 "$DIR/.iou"
chown -R root:root "$DIR"; chown -R "$USER:$USER" "$DIR/.iou"

echo "==> secrets directory $ENVDIR (0700, root-owned)"
install -d -o root -g "$USER" -m 750 "$ENVDIR"
if [[ ! -f "$ENVDIR/iou.env" ]]; then
  cat > "$ENVDIR/iou.env" <<'ENVEOF'
# Fill these in, then: systemctl start iou
# This file is mode 600. Never commit it, never paste it into a chat, never cat it on a call.

# A DEDICATED Anthropic key, used by nothing else, with a spend limit set in the console.
# Revoke it after the event and this deployment simply goes quiet.
ANTHROPIC_API_KEY=

# The GitHub App. The App must be installed on ONE repository, with contents:read only.
IOU_APP_ID=
IOU_INSTALLATION_ID=
IOU_APP_PEM=/etc/iou/iou-app.pem
IOU_BOT_LOGIN=your-app-slug[bot]

# The repository it watches.
IOU_REPO=owner/repo

# Poll interval, seconds.
IOU_INTERVAL_S=20

# Spend ceilings. These are what make it safe to leave running against a public repository.
# Per actor per hour / per tick / for the lifetime of this deployment.
IOU_MAX_CALLS_PER_ACTOR_HOUR=12
IOU_MAX_CALLS_PER_TICK=20
IOU_MAX_CALLS_TOTAL=2000

# Model. Opus is the default; haiku is ~5x cheaper and fine for classification.
IOU_MODEL=claude-opus-5
ENVEOF
  echo "    created $ENVDIR/iou.env — FILL IT IN"
else
  echo "    $ENVDIR/iou.env already exists, left alone"
fi
chmod 600 "$ENVDIR/iou.env"; chown root:root "$ENVDIR/iou.env"

echo "==> systemd unit"
install -m 644 "$DIR/deploy/iou.service" /etc/systemd/system/iou.service
systemctl daemon-reload

cat <<EOF

Installed, not started. Two things left, both yours:

  1. Copy the GitHub App private key to $ENVDIR/iou-app.pem, then:
       chmod 600 $ENVDIR/iou-app.pem && chown root:$USER $ENVDIR/iou-app.pem
       chmod 640 $ENVDIR/iou-app.pem
  2. Fill in $ENVDIR/iou.env  (sudoedit $ENVDIR/iou.env)

Then:
     systemctl enable --now iou
     systemctl status iou
     journalctl -u iou -f

To stop it spending anything, ever again:
     systemctl disable --now iou     # and revoke the API key in the console

EOF
