#!/usr/bin/env bash
# rotate-github-token.sh — replace the Jarvis Box's GitHub token, and say when
# the old one can safely be revoked. Run as root, from inside a clone of
# tom.quest:
#
#   bash tom.quest/worker/rotate-github-token.sh --audit   # read-only report
#   bash tom.quest/worker/rotate-github-token.sh           # install a new token
#                                                          # (read from stdin)
#
# WHY ROTATION IS NOT JUST "EDIT worker.env"
#
# Three consumers read GH_TOKEN, and they do NOT pick up a new value at the
# same moment:
#
#   * the cron jobs (/opt/tts/*.mjs) call loadEnv() once per run, so a fresh
#     value is live at their next tick — minutes;
#   * /usr/local/bin/tts-git-credential re-reads /etc/tts/worker.env on every
#     single git request, so once the clean-URL code is deployed a new value is
#     live immediately, with nothing restarted;
#   * the session-host daemon calls loadEnv() ONCE, in main(), and keeps that
#     object for its whole life (session-host.mjs). On a box still running the
#     tokenised-URL code it writes the value it read at start into every
#     session clone's remote URL, so it keeps using the OLD token until it is
#     restarted — and restarting it ends every live autonomous session.
#
# Measured 2026-09-01 on the Jarvis Box (probe run inside a session work tree,
# bogus tokens only, nothing outside the tree written): when a remote URL
# carries a credential and GitHub rejects it, git does NOT fall back to a
# credential helper. The helper is called with `erase` and never with `get`,
# and the fetch fails. Installing the helper therefore does not rescue a
# checkout whose URL holds a revoked token.
#
# THE ORDER THAT FOLLOWS FROM THAT
#
#   1. Create the replacement token in GitHub, leaving the old one VALID.
#   2. Run this script to install it (no restart, nothing dies).
#   3. Deploy the clean-URL code with setup.sh at a quiet moment; that restart
#      is what stops new copies of any token being written into remote URLs.
#      setup.sh also runs scrub-token-urls.sh, which rewrites the remote URLs
#      of checkouts that already exist — deploying alone would leave those
#      copies of the old value on disk, including the ones under /tmp that
#      outlive the session that made them.
#   4. Run `--audit` until it says the old token is unused, then revoke it in
#      GitHub.
#
# Revoking FIRST is the order that breaks the fleet: every checkout the old
# daemon made — including the ones live sessions are working in — authenticates
# with the embedded old value, so their pushes and every new private-repo clone
# fail until the daemon is restarted onto the new code.
#
# This script never prints the token, never takes it as a command-line argument
# (argv is visible to `ps` and lands in shell history), and leaves no backup
# copy of the old value behind.
set -euo pipefail

ENV_FILE=/etc/tts/worker.env
HELPER_PATH=/usr/local/bin/tts-git-credential
PRIVATE_REPO=Heffnt/ComplexMultiTrigger   # private: proves the token reads
PUBLIC_REPO=Heffnt/tom.quest              # public for reads; push needs auth
DEPLOYED_DIR=/opt/tts
# Where checkouts made by the box live. A credential in any .git/config here is
# a copy of the token outside worker.env.
SCAN_DIRS=(/var/cache/tts /var/lib/tts /tmp /opt/tts)

WORKER_DIR="$(cd "$(dirname "$0")" && pwd)"

MODE=install
SKIP_PUSH_CHECK=0
for arg in "$@"; do
  case "$arg" in
    --audit) MODE=audit ;;
    --skip-push-check) SKIP_PUSH_CHECK=1 ;;
    *) echo "usage: $0 [--audit] [--skip-push-check]" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "rotate-github-token.sh must run as root" >&2
  exit 1
fi

# ── the audit: is the old token still in use anywhere? ───────────────────────

# Count .git/config files whose remote URL carries a credential. Paths are
# printed, the file contents never are — the credential is on those lines.
tokenised_checkouts() {
  local d
  for d in "${SCAN_DIRS[@]}"; do
    [ -d "$d" ] || continue
    find "$d" -maxdepth 6 -path '*/.git/config' -type f 2>/dev/null \
      | xargs -r grep -l '@github\.com' 2>/dev/null || true
  done
}

# The daemon process, so its start time can be compared with worker.env's.
daemon_pid() {
  pgrep -f 'session-host/session-host\.mjs' 2>/dev/null | head -1
}

audit() {
  local deployed_tokenised=no unused=yes checkouts count pid
  if grep -rq 'x-access-token' "$DEPLOYED_DIR" 2>/dev/null; then
    deployed_tokenised=yes
  fi
  echo "deployed code    : $DEPLOYED_DIR $(
    [ "$deployed_tokenised" = yes ] \
      && echo 'still writes the token into remote URLs (pre-rollout)' \
      || echo 'uses clean URLs')"
  [ "$deployed_tokenised" = no ] || unused=no

  checkouts="$(tokenised_checkouts)"
  count=$(printf '%s' "$checkouts" | grep -c . || true)
  echo "checkouts holding a credential in .git/config: $count"
  if [ "$count" -gt 0 ]; then
    unused=no
    printf '%s\n' "$checkouts" | sed 's/^/  /'
    echo "  (each of these authenticates with whatever token was current when it"
    echo "   was cloned; revoking that token breaks their fetches and pushes)"
    echo "  To empty this list without deleting anyone's work, run"
    echo "  'bash $WORKER_DIR/scrub-token-urls.sh' — it rewrites each of those"
    echo "  remote URLs to its plain form, after which the credential helper"
    echo "  supplies the token instead. It restarts nothing."
  fi

  pid="$(daemon_pid)"
  if [ -n "$pid" ]; then
    echo "session-host     : pid $pid, started $(ps -o lstart= -p "$pid" | sed 's/^ *//')"
    echo "worker.env       : last written $(stat -c %y "$ENV_FILE" 2>/dev/null || echo unknown)"
    if [ -n "$pid" ] && [ "$ENV_FILE" -nt "/proc/$pid" ]; then
      echo "  the daemon started BEFORE worker.env was last written, so the value"
      echo "  it holds in memory is the older one"
      [ "$deployed_tokenised" = no ] || unused=no
    fi
  else
    echo "session-host     : not running"
  fi

  if [ "$unused" = yes ]; then
    echo
    echo "VERDICT: nothing on this box still authenticates with an older token."
    echo "Revoking the previous token in GitHub is safe."
    return 0
  fi
  echo
  echo "VERDICT: an older token is still in use here. Deploy the clean-URL code"
  echo "(setup.sh, at a quiet moment) and let the listed checkouts be replaced"
  echo "before revoking it in GitHub."
  return 1
}

if [ "$MODE" = audit ]; then
  audit
  exit $?
fi

# ── installing a new token ───────────────────────────────────────────────────

if [ -t 0 ]; then
  echo "Paste the new GitHub token, then press Enter (it will not be echoed):"
  IFS= read -rs NEW_TOKEN || true
  echo
else
  # `|| true`: read reports end-of-input as a non-zero status, and under
  # `set -e` that would end the script before the empty-input message below.
  IFS= read -r NEW_TOKEN || true
fi
NEW_TOKEN="${NEW_TOKEN:-}"
# Forgiving about a whole "GH_TOKEN=..." line being pasted; strict about
# anything else, because a mangled value installs a box that cannot clone.
NEW_TOKEN="${NEW_TOKEN#GH_TOKEN=}"
NEW_TOKEN="${NEW_TOKEN%$'\r'}"
case "$NEW_TOKEN" in
  "") echo "no token on stdin — nothing written" >&2; exit 1 ;;
  *[[:space:]]*) echo "the token contains whitespace — nothing written" >&2; exit 1 ;;
esac

# Verify BEFORE writing. A token that cannot read the private repository would
# stop every session start and every code-todo tick, and the failure would show
# up minutes later inside git rather than here.
echo "== checking the new token (nothing written yet) =="
ASKPASS="$(mktemp)"
trap 'rm -f "$ASKPASS"' EXIT
chmod 700 "$ASKPASS"
# The token reaches git through the environment, not through this file: the
# file only names the variable.
cat > "$ASKPASS" <<'EOF'
#!/bin/sh
case "$1" in
  *Username*) printf 'x-access-token\n' ;;
  *) printf '%s\n' "$TTS_ROTATE_TOKEN" ;;
esac
EOF

if ! GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$ASKPASS" TTS_ROTATE_TOKEN="$NEW_TOKEN" \
     git -c credential.helper= ls-remote --heads \
     "https://github.com/$PRIVATE_REPO.git" >/dev/null 2>&1; then
  echo "the new token cannot read $PRIVATE_REPO — nothing written." >&2
  echo "It needs read access to that repository, or no session can start." >&2
  exit 1
fi
echo "  reads $PRIVATE_REPO (private): yes"

if [ "$SKIP_PUSH_CHECK" -eq 0 ]; then
  for repo in "$PRIVATE_REPO" "$PUBLIC_REPO"; do
    # The Authorization header goes to curl through a config file on stdin, not
    # through -H: an argument is visible to anyone who can run `ps` while the
    # request is open, and stdin is not.
    perms="$(printf '%s\n' \
        "header = \"Authorization: Bearer $NEW_TOKEN\"" \
        'header = "Accept: application/vnd.github+json"' \
      | curl -fsS -K - "https://api.github.com/repos/$repo" 2>/dev/null \
      | tr -d ' \n' | grep -o '"push":\(true\|false\)' | head -1 || true)"
    case "$perms" in
      '"push":true') echo "  pushes to $repo: yes" ;;
      '"push":false')
        echo "the new token cannot push to $repo — nothing written." >&2
        echo "Sessions and the executor push branches; grant write access." >&2
        exit 1 ;;
      *)
        echo "could not confirm push access to $repo — nothing written." >&2
        echo "Re-run with --skip-push-check to install it anyway." >&2
        exit 1 ;;
    esac
  done
fi

# Write it. Atomic rename inside /etc/tts so no reader ever sees a half-written
# file, restrictive permissions from creation, and NO backup copy: a .bak would
# be a second plaintext home for the value being retired.
echo "== writing $ENV_FILE =="
TMP_ENV="$(mktemp "$ENV_FILE.new.XXXXXX")"
chmod 600 "$TMP_ENV"
if [ -f "$ENV_FILE" ]; then
  chown --reference="$ENV_FILE" "$TMP_ENV" 2>/dev/null || true
  TTS_ROTATE_TOKEN="$NEW_TOKEN" awk '
    /^GH_TOKEN=/ { print "GH_TOKEN=" ENVIRON["TTS_ROTATE_TOKEN"]; seen=1; next }
    { print }
    END { if (!seen) print "GH_TOKEN=" ENVIRON["TTS_ROTATE_TOKEN"] }
  ' "$ENV_FILE" > "$TMP_ENV"
else
  printf 'GH_TOKEN=%s\n' "$NEW_TOKEN" > "$TMP_ENV"
fi
mv -f "$TMP_ENV" "$ENV_FILE"
echo "  GH_TOKEN replaced; every other line kept, no backup file left behind"

# gh's credential file is derived from worker.env, so it has to be regenerated;
# the git helper needs nothing, because it re-reads worker.env per request.
echo "== regenerating derived credentials =="
bash "$WORKER_DIR/install-git-credentials.sh" >/dev/null
echo "  $HELPER_PATH registered, /root/.config/gh/hosts.yml rewritten"

echo "== checking the box through the installed helper =="
if GIT_TERMINAL_PROMPT=0 git ls-remote --heads \
   "https://github.com/$PRIVATE_REPO.git" >/dev/null 2>&1; then
  echo "  a clean-URL read of $PRIVATE_REPO succeeds"
else
  echo "  a clean-URL read of $PRIVATE_REPO FAILED — the helper is not answering;" >&2
  echo "  run install-git-credentials.sh --check" >&2
fi

echo
echo "== is the previous token safe to revoke? =="
audit || true
