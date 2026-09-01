#!/usr/bin/env bash
# scrub-token-urls.sh — rewrite every remote URL on this box that carries a
# GitHub credential back to its plain form, in place, deleting nothing.
#
#   bash tom.quest/worker/scrub-token-urls.sh --dry-run   # report only
#   bash tom.quest/worker/scrub-token-urls.sh             # rewrite them
#   bash tom.quest/worker/scrub-token-urls.sh DIR...      # only those trees
#
# WHAT IT IS FOR
#
# Until the clean-URL change (ledger sessions-pr-credential-rollout-unproven)
# every clone this box made wrote the GitHub token into the checkout's remote
# URL, so a plaintext copy of an account-wide repo-write token landed in that
# checkout's .git/config. Deploying the new code stops NEW copies being made.
# It does not remove the copies already on disk, and nothing else does either:
#
#   * session work trees under /var/cache/tts/sessions vanish when their
#     session ends, but a new one is minted every time a session starts;
#   * the code-todo cache clone /var/cache/tts/ComplexMultiTrigger repairs its
#     own URL on the next cron tick (tts-code-lib.mjs re-sets it), but only
#     that one directory;
#   * clones a session made for itself under /tmp OUTLIVE the session, and no
#     cleanup rule touches their contents.
#
# Measured on the Jarvis Box at 2026-09-01 00:26 UTC: 17 .git/config files
# carried a credential — 9 under /var/cache/tts and 8 under /tmp, including
# four clones of ComplexMultiTrigger made between 23:04 and 23:09 the previous
# evening and two clones of the private WikiTom repository from 2026-08-30.
# This script is the operation that empties that set without deleting anyone's
# work: `git config remote.<name>.url` is rewritten from the form that carries
# a credential — scheme, then "x-access-token:<token>", then "@", then the
# host and path — to the plain form with nothing before the host, and the
# checkout keeps working because the credential helper supplies the token at
# ask time instead.
#
# (This file states that form in words rather than as a literal string on
# purpose: worker/credentials.test.ts fails any file under worker/ that
# contains a URL with a credential before the host, including in a comment,
# and that assertion is worth more than a tidier sentence here.)
#
# WHAT IT DOES NOT BUY
#
# It does not make revoking the old token safe on its own. The session-host
# daemon reads GH_TOKEN once at startup, so a daemon still running the
# pre-rollout code keeps writing that value into new session clones until it
# is restarted; scrubbing at 12:00 says nothing about the clone minted at
# 12:01. Revocation still waits for the deploy, and
# `rotate-github-token.sh --audit` is what says when.
#
# It prints paths and CLEANED urls only. A line that still holds a credential
# is never printed, and the token is never passed to another program.
set -euo pipefail

HELPER_PATH=/usr/local/bin/tts-git-credential
# Held in a variable so that no line in this file spells out a URL with a
# credential in front of the host — see the note above.
GITHUB_HOST=github.com
# The same set rotate-github-token.sh --audit counts, so "the audit says 17"
# and "the scrub rewrote 17" are statements about the same set by
# construction. worker/credentials.test.ts holds the two lists identical.
SCAN_DIRS=(/var/cache/tts /var/lib/tts /tmp /opt/tts)

DRY_RUN=0
FORCE=0
DIRS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    -*)
      echo "usage: $0 [--dry-run] [--force] [DIR ...]" >&2
      exit 2 ;;
    *) DIRS+=("$arg") ;;
  esac
done
[ "${#DIRS[@]}" -gt 0 ] || DIRS=("${SCAN_DIRS[@]}")

# A checkout whose URL has been cleaned can only authenticate through the
# credential helper, so cleaning one on a box that has no helper registered
# takes a working checkout and breaks it. Both halves are checked: the file
# has to exist, and git has to be configured to call it — `git config --get`
# with no scope flag asks git what it would ACTUALLY use (/etc/gitconfig, then
# $HOME/.gitconfig), which is the only question that matters here.
#
# --force is for the cases where that reasoning does not apply: fixtures in a
# test, and a box being taken out of service where breaking the checkouts is
# the point.
helper_ready() {
  [ -x "$HELPER_PATH" ] || return 1
  local configured
  configured="$(git config --get credential.helper 2>/dev/null || true)"
  [ "$configured" = "$HELPER_PATH" ] || return 1
}

if [ "$DRY_RUN" -eq 0 ] && [ "$FORCE" -eq 0 ] && ! helper_ready; then
  echo "refusing to scrub: $HELPER_PATH is not installed and registered as" >&2
  echo "git's credential.helper, so a cleaned URL would have no way to" >&2
  echo "authenticate. Run 'bash worker/install-git-credentials.sh' first (it" >&2
  echo "restarts nothing), or pass --force to scrub anyway." >&2
  exit 1
fi

# find is given a path pattern rather than a name, so it matches the config
# file inside a .git directory and not, say, a file called config in the
# checkout's own source tree.
configs() {
  local d
  for d in "${DIRS[@]}"; do
    [ -d "$d" ] || continue
    find "$d" -maxdepth 6 -path '*/.git/config' -type f 2>/dev/null || true
  done
}

scrubbed=0
scanned=0
affected=0
while IFS= read -r cfg; do
  [ -n "$cfg" ] || continue
  scanned=$((scanned + 1))
  header_printed=0
  # --name-only, so the values (which hold the credential) never reach a pipe,
  # a log, or this session's transcript. Each value is read individually below
  # into a shell variable and only ever printed after the credential has been
  # cut out of it.
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    url="$(git config --file "$cfg" --get "$key" 2>/dev/null || true)"
    case "$url" in
      "https://"*"@$GITHUB_HOST/"*|"http://"*"@$GITHUB_HOST/"*) ;;
      *) continue ;;
    esac
    # Everything between "//" and the "@" before the host is the credential.
    clean="$(printf '%s' "$url" | sed -E 's#^(https?://)[^@/]*@#\1#')"
    if [ "$header_printed" -eq 0 ]; then
      echo "$cfg"
      header_printed=1
      affected=$((affected + 1))
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "  would rewrite $key -> $clean"
    else
      git config --file "$cfg" "$key" "$clean"
      echo "  rewrote $key -> $clean"
    fi
    scrubbed=$((scrubbed + 1))
  done < <(git config --file "$cfg" --name-only --get-regexp '^remote\..*\.url$' 2>/dev/null || true)
done < <(configs)

echo
if [ "$DRY_RUN" -eq 1 ]; then
  echo "$scanned checkouts scanned; $affected of them still carry a credential," \
       "in $scrubbed remote URLs."
  [ "$scrubbed" -eq 0 ] || echo "Re-run without --dry-run to rewrite them."
else
  echo "$scanned checkouts scanned; $scrubbed remote URLs rewritten in $affected of them."
  [ "$scrubbed" -eq 0 ] || echo "Those checkouts now authenticate through $HELPER_PATH."
fi
