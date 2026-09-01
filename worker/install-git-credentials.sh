#!/usr/bin/env bash
# install-git-credentials.sh — put the Jarvis Box's GitHub credentials in
# place, and nothing else. Run as root, from inside a clone of tom.quest:
#
#   bash tom.quest/worker/install-git-credentials.sh          # install
#   bash tom.quest/worker/install-git-credentials.sh --check   # report only
#   bash tom.quest/worker/install-git-credentials.sh --verify-clean-url
#                                        # can the daemon's git authenticate?
#
# WHY THIS IS ITS OWN FILE AND NOT JUST A BLOCK INSIDE setup.sh
#
# setup.sh is the whole-box installer and its step 8 ends with
# `systemctl restart tts-session-host`. That restart is not free. The daemon
# holds every live session inside its own process (`const sessions = new Map()`
# in session-host.mjs), and when the new process adopts the rows afterwards,
# adoptSession() ENDS every autonomous session it finds — outcome "errored",
# summary "daemon restarted mid-mission" — and deletes its work tree. An
# interactive session survives as idle with its current turn interrupted; an
# autonomous one loses whatever it had not committed and waits for the
# scheduler's backoff. Rolling the credential change out through setup.sh
# therefore costs every autonomous session running at that moment.
#
# The credential install itself needs no restart. It writes three files, and
# every git or gh process started after it reads them — including the sessions
# already running, because each shell command a session runs is a fresh
# process. So this file exists to be run FIRST, on a live box, at any time.
# setup.sh then calls it, so there is exactly one copy of the procedure and no
# chance of the two drifting apart.
#
# Running it EARLY is also the safe order. Until the new daemon and job code
# are deployed, the box still clones with the token written into the remote
# URL; git prefers a credential embedded in the URL over any helper, so
# installing the helper first changes nothing that already works. Deploying
# the other order — clean-URL code on a box with no helper — fails every clone
# and push, because both repositories are private.
#
# WHAT IT INSTALLS
#
#   /usr/local/bin/tts-git-credential  the helper script itself: git runs it at
#       the moment it needs a password, and it prints the token read from
#       /etc/tts/worker.env. Nothing else on the box needs to hold the value.
#   /etc/gitconfig                     credential.helper pointing at that path,
#       written with `git config --system`. NOT --global: "global" means
#       "$HOME/.gitconfig", and the daemon runs with no HOME at all, so a
#       per-user registration is invisible in exactly the processes that use
#       the clean URLs. /etc/gitconfig is the one config file git reads with
#       no HOME set.
#   /root/.config/gh/hosts.yml         gh's own credential file, regenerated
#       from worker.env on every run (a derived file, never hand-edited). gh
#       does not use git's credential helper; it reads this file, resolving
#       the path from HOME — which is why the systemd unit and the cron file
#       both state HOME=/root.
#
# The token's one home stays /etc/tts/worker.env (root-only, mode 600). This
# script never prints it.
set -euo pipefail

HELPER_PATH=/usr/local/bin/tts-git-credential
ENV_FILE=/etc/tts/worker.env
GH_HOSTS=/root/.config/gh/hosts.yml
# Private on GitHub, and cloned by every session at start-up: reading it with a
# clean URL is the whole credential path exercised end to end, and no session
# can start on a box where that read fails. --verify-clean-url below asks
# exactly that question.
PRIVATE_REPO=Heffnt/ComplexMultiTrigger

# Directory this script lives in (the repo's worker/ dir), so the copy below
# works no matter what the current working directory is.
WORKER_DIR="$(cd "$(dirname "$0")" && pwd)"

MODE=install
case "${1:-}" in
  "") MODE=install ;;
  --check) MODE=check ;;
  --verify-clean-url) MODE=verify ;;
  *) echo "usage: $0 [--check | --verify-clean-url]" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  echo "usage: $0 [--check | --verify-clean-url]" >&2
  exit 2
fi

# --verify-clean-url is exempt: it writes nothing, reads no secret value, and
# has to be runnable by the test suite on an ordinary developer account.
if [ "$MODE" != verify ] && [ "$(id -u)" -ne 0 ]; then
  echo "install-git-credentials.sh must run as root" >&2
  exit 1
fi

# Presence only, never the value: a token that reaches a log or a transcript is
# the defect this whole change exists to end. The optional argument names a
# different env file; only --verify-clean-url passes one, and only so that the
# test suite can exercise both of its branches without a file under /etc.
token_present() {
  [ -n "$(sed -n 's/^GH_TOKEN=//p' "${1:-$ENV_FILE}" 2>/dev/null | tail -1)" ]
}

# --verify-clean-url: can a git process started the way the DAEMON starts one
# read the private repository through a clean URL? Nothing else on this box
# answers that, and the answer is what separates a working deploy from a fleet
# that cannot start a session.
#
# WHY IT IS ASKED WITH NO HOME. session.mjs clones every repository from a URL
# with no credential in it, so the only thing that can authenticate that clone
# is the credential helper, and git finds the helper only in a configuration
# file it actually reads. The daemon's systemd unit sets HOME=/root, but the
# read below deliberately drops HOME anyway: with no HOME, git reads
# /etc/gitconfig and nothing else, so a helper registered per-user — `git
# config --global`, which writes $HOME/.gitconfig — counts as missing here.
# That is the distinction this check exists to catch, because a per-user
# registration looks correct on the command line of the person running setup.sh
# and is invisible to a service that has no HOME. Measured on the Jarvis Box
# 2026-09-01: `git config --get credential.helper` with HOME set to a directory
# holding such a registration prints the helper and exits 0; the same command
# with HOME unset prints nothing and exits 1.
#
# TTS_VERIFY_REMOTE and TTS_VERIFY_ENV_FILE exist for worker/credentials.test.ts,
# which points them at a local repository and a stand-in env file so the two
# branches below can be exercised without network access and without reading
# anything under /etc. Neither is set anywhere in production, and both are read
# only — no mode of this script writes to either.
verify_clean_url() {
  local remote env_file
  remote="${TTS_VERIFY_REMOTE:-https://github.com/$PRIVATE_REPO.git}"
  env_file="${TTS_VERIFY_ENV_FILE:-$ENV_FILE}"

  if env -u HOME GIT_TERMINAL_PROMPT=0 git ls-remote --heads "$remote" \
       >/dev/null 2>&1; then
    echo "clean-URL read of $remote, with no HOME: yes"
    return 0
  fi

  if ! token_present "$env_file"; then
    # A box being built for the first time reaches this point legitimately:
    # setup.sh seeds the env file from the template AFTER this call, so there
    # is no token yet and no session to lose. Say what is missing and let the
    # install finish.
    echo "clean-URL read of $remote, with no HOME: NO, and GH_TOKEN is not set"
    echo "  in $env_file. That is the normal state of a box being built for the"
    echo "  first time. Fill GH_TOKEN in and run setup.sh again; until then no"
    echo "  session can start, because every session clones a private repository."
    return 0
  fi

  echo "clean-URL read of $remote, with no HOME: NO." >&2
  echo "  A token IS set in $env_file, so this is a broken credential path, not" >&2
  echo "  an unfinished box. Every session clones that repository with a URL" >&2
  echo "  that carries no credential, so on this box no session could start." >&2
  echo "  Run '$0 --check' to see which of the three pieces is missing. The" >&2
  echo "  usual cause is a helper registered with 'git config --global', which" >&2
  echo "  writes \$HOME/.gitconfig and is invisible to a service that has no" >&2
  echo "  HOME; this script registers it with 'git config --system' instead." >&2
  echo "  Setting TTS_SKIP_CLEAN_URL_CHECK=1 makes setup.sh deploy anyway." >&2
  return 1
}

if [ "$MODE" = verify ]; then
  verify_clean_url
  exit $?
fi

if [ "$MODE" = check ]; then
  ok=0
  if [ -x "$HELPER_PATH" ]; then
    if cmp -s "$WORKER_DIR/bin/tts-git-credential" "$HELPER_PATH"; then
      echo "helper           : installed, matches this checkout"
    else
      echo "helper           : installed but DIFFERS from this checkout"
      ok=1
    fi
  else
    echo "helper           : MISSING ($HELPER_PATH)"
    ok=1
  fi

  registered="$(git config --system --get credential.helper 2>/dev/null || true)"
  if [ "$registered" = "$HELPER_PATH" ]; then
    echo "credential.helper: $registered (system scope)"
  elif [ -n "$registered" ]; then
    echo "credential.helper: $registered — NOT the helper this installs"
    ok=1
  else
    echo "credential.helper: NOT REGISTERED in /etc/gitconfig"
    ok=1
  fi

  if token_present; then
    echo "GH_TOKEN         : set in $ENV_FILE"
  else
    echo "GH_TOKEN         : MISSING from $ENV_FILE"
    ok=1
  fi

  if [ -f "$GH_HOSTS" ]; then
    echo "gh hosts.yml     : present ($GH_HOSTS)"
  else
    echo "gh hosts.yml     : MISSING ($GH_HOSTS)"
    ok=1
  fi

  exit "$ok"
fi

echo "== git credential helper =="
install -m 0755 "$WORKER_DIR/bin/tts-git-credential" "$HELPER_PATH"
git config --system credential.helper "$HELPER_PATH"
echo "  $HELPER_PATH installed and registered as git's system credential.helper"

echo "== gh credentials =="
GH_TOKEN_VALUE="$(sed -n 's/^GH_TOKEN=//p' "$ENV_FILE" 2>/dev/null | tail -1)"
if [ -n "$GH_TOKEN_VALUE" ]; then
  mkdir -p "$(dirname "$GH_HOSTS")"
  # Written with a restrictive umask rather than chmod-after-write: between the
  # two there is a moment when the file is world-readable.
  (umask 077 && cat > "$GH_HOSTS" <<EOF
github.com:
    oauth_token: $GH_TOKEN_VALUE
    git_protocol: https
EOF
  )
  echo "  gh authenticated from worker.env ($GH_HOSTS regenerated)"
else
  echo "  GH_TOKEN not set in $ENV_FILE — gh stays unauthenticated and"
  echo "  private-repo clones will fail; fill it in and re-run this script."
fi

echo "== check =="
# `|| true`: --check exits non-zero when something is missing, and on a FRESH
# box that is the normal state at this point — setup.sh calls this script
# before it seeds /etc/tts/worker.env from the template, so GH_TOKEN is
# legitimately absent on the first run and the rebuild must not abort. The
# lines it prints are the report; the exit status matters only when a person
# runs `--check` on its own to ask whether the box is ready.
"$0" --check || true
