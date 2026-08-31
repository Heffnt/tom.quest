#!/bin/sh
# Scratch cleaning for the Jarvis worker box: reap /tmp, and move scratch off it.
#
# Run as root, either on its own —
#     sh worker/scratch-cleaning.sh
# — or as step 8 of worker/setup.sh, which calls this file. Running it on its own
# is the way to apply the change WITHOUT restarting tts-session-host, because
# restarting that daemon kills every session running inside it. Nothing here
# touches the daemon; the TMPDIR half arrives at its next restart, whenever that
# happens to be. Everything here is idempotent.
#
# WHY THIS EXISTS. /tmp on this box is a tmpfs — a filesystem held in RAM rather
# than on a disk — sized 3.8 GB on a 7.7 GB machine, so every byte of every file
# in it is a byte the box cannot use for anything else. Nothing cleaned it on a
# useful timescale: the vendor rule this replaces (/usr/lib/tmpfiles.d/tmp.conf)
# deletes at an age of 10 days. On 2026-08-30 one session left ~2.2 GB of scratch
# there, a test in a research checkout leaked ~1,400 empty directories a day
# beside it, /tmp reached 100 percent full, and tooling inside a running session
# started failing with out-of-space errors. A session cannot repair that itself:
# writing to /etc is refused by the session command classifier.
#
# TWO CHANGES, ANSWERING DIFFERENT HALVES OF THAT. The reaper bounds
# accumulation BETWEEN sessions; it can never stop one session filling the tmpfs
# within an hour, because nothing that young is old enough to reap. Moving
# scratch onto disk (TMPDIR) is what covers the within-session case.
#
# systemd-tmpfiles is the reaper: it already runs here on a timer and already
# reads rule files from /etc/tmpfiles.d, so only the rules are new. No new
# program is written, and no cron entry is added — /etc/cron.d/tts is rewritten
# wholesale by setup.sh on every run, so a line added there would not survive.
set -e

mkdir -p /etc/tmpfiles.d /etc/systemd/system/systemd-tmpfiles-clean.timer.d

# A file in /etc/tmpfiles.d REPLACES the same-named file in /usr/lib/tmpfiles.d
# entirely — that is the documented way an administrator overrides a vendor
# rule — which is why the unchanged /var/tmp line has to be repeated here.
cat > /etc/tmpfiles.d/tmp.conf <<'TMPFILES'
# Managed by tom.quest worker/scratch-cleaning.sh — edits here are lost on the
# next run of it or of worker/setup.sh.

# "amM:2d": delete an entry under /tmp that is more than two days old, judging
# FILES by the later of access time and modification time (a, m) and
# DIRECTORIES by modification time alone (M). The default is "abcmABM".
#
# The "a" on files is what protects work in progress. Sessions clone
# repositories into /tmp by absolute path and keep using them across more than
# one day (measured 2026-08-31: five checkouts in /tmp were being read by live
# sessions, one of them created the previous day). Judging files by modification
# time alone would delete every file in such a checkout that had not been
# WRITTEN in two days, while a session was still reading it. With "a", any file
# the session reads keeps itself alive.
#
# Directories must NOT be judged by access time, which is why "A" is dropped.
# Reading a directory's entries updates its access time, so any recursive sweep
# — du, find, ls -R, a session inventorying /tmp — refreshes every directory it
# walks. The leak that helped fill this tmpfs was ~1,400 EMPTY directories a
# day; under the default they would be kept alive by the very sweeps used to
# measure them.
#
# RESIDUAL FAILURE: a checkout in /tmp used across more than two days still
# loses the worktree files nothing has read. Git restores those from the object
# store, whose pack files nearly every git command reads. The durable answer is
# not to clone into /tmp — TMPDIR points everything that asks for a scratch
# directory at disk instead.
q /tmp 1777 root root amM:2d

# unchanged from the vendor file
q /var/tmp 1777 root root 30d

# Where cron jobs and sessions now write scratch instead (TMPDIR). On
# /dev/sda1, so a job that writes gigabytes costs disk, not memory. Longer age
# than /tmp because the space is not scarce; still aged, because moving garbage
# somewhere roomier is not the same as cleaning it up. Same age-by reasoning as
# /tmp above.
q /var/cache/tts/tmp 1777 root root amM:3d
TMPFILES
chmod 644 /etc/tmpfiles.d/tmp.conf

# The timer that runs the reaper fires once a day by default, so an entry can
# sit in RAM for up to a day after passing its age. Every 6 hours costs one
# directory walk and bounds that lag. The empty assignment first is REQUIRED:
# timer settings accumulate across drop-in files, so without it the unit would
# carry both the vendor's daily trigger and this one.
cat > /etc/systemd/system/systemd-tmpfiles-clean.timer.d/10-tts-frequent.conf <<'TIMER'
# Managed by tom.quest worker/scratch-cleaning.sh — edits here are lost.
[Timer]
OnUnitActiveSec=
OnUnitActiveSec=6h
TIMER
chmod 644 /etc/systemd/system/systemd-tmpfiles-clean.timer.d/10-tts-frequent.conf

# 1777 (world-writable, sticky) matches /tmp's own mode. The tmpfiles rule above
# re-creates this directory at every boot; this line is what makes it exist now.
mkdir -p /var/cache/tts/tmp
chmod 1777 /var/cache/tts/tmp

# TMPDIR for the session daemon, as a drop-in rather than an edit to the unit
# file. setup.sh writes the same setting into the unit itself, so on a box built
# by setup.sh the two agree and systemd takes the drop-in; this file is what
# makes the setting arrive when this script is run ON ITS OWN against a box
# whose unit file predates the change. Applies at the daemon's next restart.
mkdir -p /etc/systemd/system/tts-session-host.service.d
cat > /etc/systemd/system/tts-session-host.service.d/10-tmpdir.conf <<'TMPDIR_DROPIN'
# Managed by tom.quest worker/scratch-cleaning.sh — edits here are lost.
[Service]
Environment=TMPDIR=/var/cache/tts/tmp
TMPDIR_DROPIN
chmod 644 /etc/systemd/system/tts-session-host.service.d/10-tmpdir.conf

systemctl daemon-reload
systemctl restart systemd-tmpfiles-clean.timer
echo "  /tmp reaped at 2d, /var/cache/tts/tmp at 3d, timer every 6h"
echo "  (see what it would remove, removing nothing: systemd-tmpfiles --clean --dry-run)"
echo "  TMPDIR=/var/cache/tts/tmp applies at the next restart of tts-session-host"

# NO EXEMPTIONS ARE INSTALLED, DELIBERATELY. systemd-tmpfiles takes an "x PATH"
# line to hold a path back from cleaning. One machine's list of paths worth
# holding back is not part of building a box — a rebuilt box has no such paths —
# so an operator who wants one writes /etc/tmpfiles.d/zz-tts-keep.conf by hand,
# and neither this script nor setup.sh creates or deletes that file. Nothing on
# the live box needs one today: the "a" in the age-by rule is what keeps a
# checkout somebody is still reading.
