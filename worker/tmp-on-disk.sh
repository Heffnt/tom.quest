#!/bin/sh
# Take /tmp off RAM on the Jarvis worker box, permanently.
#
# Run as root, either on its own —
#     sh worker/tmp-on-disk.sh
# — or as part of step 8 of worker/setup.sh, which calls this file after
# worker/scratch-cleaning.sh. It changes nothing that is running: it marks the
# systemd unit that mounts /tmp as a tmpfs so that unit is skipped, and that
# takes effect at the NEXT BOOT. No process is stopped, no session is killed,
# no file is deleted, and the tmpfs stays mounted and keeps working until then.
# Rebooting is a separate decision for whoever runs this, and it is the moment
# the change actually arrives.
#
# WHY THIS EXISTS, AND WHY THE REAPER ALONE IS NOT ENOUGH.
#
# /tmp on this box is a tmpfs: a filesystem held in RAM, sized 3.8 GB on a
# 7.7 GB machine, so every byte of every file in it is a byte the machine
# cannot use for anything else. On 2026-08-30 it reached 100 percent full and
# tooling inside a running session began failing with out-of-space errors.
#
# worker/scratch-cleaning.sh answers that with two mechanisms, and measurement
# on 2026-08-31 at 23:41 UTC shows neither one covers what is actually filling
# this tmpfs:
#
#   * The reaper deletes entries older than two days. At that moment /tmp held
#     3.2 GB and NOTHING in it was two days old — the oldest top-level entry
#     was 1.85 days. Feeding the exact installed rule to
#     "systemd-tmpfiles --clean --dry-run" against the real /tmp selected zero
#     entries; the same rule at a one-hour age selected 37,051, which is how we
#     know the check itself works. The reaper bounds what accumulates BETWEEN
#     sessions. It can never touch what one session writes in an hour.
#
#   * TMPDIR moves scratch onto disk, but only for programs that ASK where to
#     put scratch — mkdtemp, mktemp, tempfile, os.tmpdir. Of the 3.2 GB in /tmp
#     at that moment, 86 MB (2 percent) sat in entries created that way. The
#     other 3,086 MB (97 percent) sat at paths an agent typed out in full:
#     four clones of one 417 MB research repository at /tmp/killcheck through
#     /tmp/killcheck4, made between 23:04 and 23:09 by a single session, plus
#     eight more repository checkouts. TMPDIR does not redirect a literal
#     "/tmp/killcheck" and nothing can make it.
#
# So the thing filling this tmpfs is agents cloning repositories to /tmp paths
# they choose themselves, minutes at a time. The only mechanism that answers
# that is /tmp not being in RAM. /dev/sda1 has 48 GB free against the tmpfs's
# 3.8 GB, and a clone there costs disk, which this box has, rather than memory,
# which it does not.
#
# WHAT CHANGES AND WHAT DOES NOT. Everything keeps working exactly as written:
# /tmp remains /tmp, world-writable and sticky, at the same path, for every
# program. The directory that appears once the tmpfs is gone already exists on
# the root filesystem, with mode 1777 (verified 2026-08-31 by reading the ext4
# inode directly with "debugfs -R 'ls -l /' /dev/sda1", which reports 41777 for
# tmp), so /tmp is correct from the first instant of boot.
#
# THE ONE PROPERTY LOST is that a tmpfs is empty after every reboot. A /tmp on
# disk is not, so from then on the ONLY thing deleting anything from /tmp is
# the age rule that worker/scratch-cleaning.sh installs. That is why this
# script refuses to run until that rule is in place.
set -e

# These four are overridable ONLY so the guards below can be exercised without
# a box to break: a session cannot write under /etc or run systemctl, so the
# only way to show that the checks fire in the right order and refuse for the
# right reasons is to point them at files that do exist. Left alone they are
# the real paths.
: "${TMP_ON_DISK_DRY_RUN:=}"   # set to 1 to run every check and skip the mask
: "${TMPFILES_RULE:=/etc/tmpfiles.d/tmp.conf}"
: "${MOUNT_UNIT:=/usr/lib/systemd/system/tmp.mount}"
: "${MIN_FREE_GB:=10}"

if [ ! -f "$MOUNT_UNIT" ]; then
  echo "  tmp.mount is not shipped on this system; nothing to mask, /tmp is not"
  echo "  a systemd-mounted tmpfs here. Leaving everything alone."
  exit 0
fi

# HARD REQUIREMENT, not a warning. Without the age rule, a /tmp on disk is
# never cleaned by anything at all: the reboot that used to empty it no longer
# does. Ubuntu's own rule is not a substitute — it deletes at ten days, which
# is what let this fill in the first place.
if [ ! -f "$TMPFILES_RULE" ]; then
  echo "  REFUSING: $TMPFILES_RULE is not installed." >&2
  echo "  A /tmp on disk is not emptied by rebooting, so the age rule in" >&2
  echo "  worker/scratch-cleaning.sh becomes the only thing that ever cleans" >&2
  echo "  it. Run that script first (worker/setup.sh runs both, in order)." >&2
  exit 1
fi

# Trading a full tmpfs for a full root filesystem would be a worse failure:
# a full / breaks the daemon, the logs and the package manager, not just
# scratch. Refuse rather than create that.
FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
if [ "${FREE_GB:-0}" -lt "$MIN_FREE_GB" ]; then
  echo "  REFUSING: only ${FREE_GB} GB free on /, below the ${MIN_FREE_GB} GB floor." >&2
  echo "  Moving scratch onto a nearly full root filesystem trades a broken" >&2
  echo "  tmpfs for a broken box. Free space first." >&2
  exit 1
fi

# "mask" rather than "disable": tmp.mount is a static unit pulled in by
# local-fs.target.wants, and disable does not apply to static units. Masking
# points the unit at /dev/null so systemd skips it. Checked on this box: no
# unit Requires= or BindsTo= tmp.mount, so nothing fails to start without it —
# the reverse dependencies are all ordering (After=) from services that use
# PrivateTmp, and ordering on a unit that never starts is not an error.
# Idempotent: masking an already-masked unit is a no-op.
if [ -n "$TMP_ON_DISK_DRY_RUN" ]; then
  echo "  TMP_ON_DISK_DRY_RUN set: every check above passed; not masking."
  exit 0
fi
systemctl mask tmp.mount

echo "  tmp.mount masked: at the next boot /tmp is a directory on the root"
echo "  filesystem (${FREE_GB} GB free) instead of a 3.8 GB slice of RAM."
echo "  NOTHING CHANGED YET — the tmpfs stays mounted and in use until you"
echo "  reboot, and rebooting kills every session running at that moment."
echo "  To undo: systemctl unmask tmp.mount"
