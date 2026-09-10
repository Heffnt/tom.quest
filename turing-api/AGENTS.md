# turing-api

## service

- A FastAPI service on the WPI Turing cluster exposing GPU, job and terminal endpoints.
- It binds `127.0.0.1`; only the co-located cloudflared reaches it, not the cluster LAN.
- `/file` and `/dirs` are confined to `TURING_FILE_ROOT` (default: home) and refuse secret-bearing paths.
- `GET /boolback-snapshot` globs the whole artifact tree (hundreds of gigabytes): seconds warm, tens of seconds cold. The blob endpoint never walks the tree and answers in under a second.
- A snapshot rebuild POST returns after about 30 s because the `sbatch` submit is slow.

## keys

- `TURING_API_KEY` (`verify_api_key`) opens the whole surface, `POST /sessions/{name}/run` included, which is arbitrary shell on the cluster.
- `TURING_READ_KEY` (`verify_read_key`) opens only `GET /gpu-report`, `GET /jobs` and `GET /sessions/{name}/output`; it accepts either key, and an unset read key fails closed to the full key.
- A caller that looks but never acts holds the read key alone.
- A new endpoint defaults to `verify_api_key`; moving one to the read door widens what every read-key holder sees.

## tunnel

- A named cloudflared tunnel maps `turing.tom.quest` to the service's local port; the URL is stable.
- The service and the tunnel run as `systemd --user` units on every cluster login node, one copy each, behind one balanced hostname.
- Without `loginctl enable-linger` for the account, a node's units exist only while a login session does; a node that lost lingering serves nothing, and the symptom is a fraction of calls timing out while the rest succeed.
- The tunnel unit is `cloudflared-turing`; asking `systemctl --user` about `cloudflared` reports a unit that does not exist as inactive.

## ssh

- A non-interactive ssh to the cluster does not source `~/.bashrc`, so SLURM and conda are off `PATH`. Export the SLURM bin directory before `squeue`, `sbatch`, `sacct` or `loginctl`; source conda's profile script before activating an environment.
