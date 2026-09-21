"""The rules the runner key is held to on POST /allocate and DELETE /jobs/{id}.

TURING_RUNNER_KEY is the third credential (main.py). It exists so a TTS runner
step on the worker box can launch and cancel jobs for its own experiment
without holding the full key, which also types arbitrary shell into any tmux
session. Everything here is a pure function over the request: no environment
reads, no subprocess. The checkout root is passed in by the caller, so what a
runner may run is decided by one place (main.py) and tested without a cluster.

Each fault function returns one sentence saying why the request is refused, or
None when it may go ahead. The sentence travels back to the runner step as the
403 detail, so it is written to be read by it.
"""
import re
import shlex
from pathlib import Path

from dirs import PathNotAllowed, resolve_within_root

# A runner owns exactly the jobs whose name carries its id, the way the GPU pool
# owns `gpupool:` names (convex/gpuPool.ts). The two prefixes never collide, so
# neither can cancel the other's jobs.
RUNNER_PREFIX = "runner:"

# The hard maximum, above which no ruling of Tom's reaches. The per-runner
# ceiling (what one launch may ask for, which his ruling raises) lives on the
# runner row in the TTS record and is enforced on the box by tts-turing-act,
# together with the GPU-hour budget; this service cannot see the row. These
# numbers only stop a runaway request, such as a step that writes its own HTTP
# call instead of using tts-turing-act. Sixteen GPUs is Tom's own cluster limit
# (his ruling of 2026-09-21), and main.py's MAX_ALLOCATION_COUNT already holds
# it for every caller. 1440 minutes is the 24-hour walltime of the `short`
# partition, where every allocation lands (spec.md §1.4). 1536000 MB is the
# largest node in that partition, the eight-GPU H200 node, from the GPU report
# of 2026-09-21. convex/ttsShared.ts RUNNER_CEILING_MAX holds the same three.
MAX_RUNNER_MINUTES = 1440
MAX_RUNNER_COUNT = 16
MAX_RUNNER_MEMORY_MB = 1536000
MAX_RUNNER_COMMANDS = 20
MAX_RUNNER_COMMAND_CHARS = 1000

_RUNNER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_LABEL_RE = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")

# Characters that make a line more than one command, redirect it, or expand
# something the check did not see. The commands are typed into an interactive
# bash inside the job, so `!` (history expansion) and parentheses (subshells)
# are refused along with the obvious ones, and so are the glob and tilde
# characters, which bash would expand into arguments the check never read.
_SHELL_METACHARACTERS = set(";&|<>$`{}()!*?[]~\n\r")

# Interpreters whose first non-flag argument is the script they run.
_INTERPRETERS = {"python", "python3", "bash", "sh"}
# The flags an interpreter may carry before its script. Anything else is
# refused: `-c` runs inline code and `-m` runs whatever module the import path
# finds, neither of which is a file the check can see.
_SAFE_INTERPRETER_FLAGS = {"-u", "-B", "-O", "-OO", "-e", "-x"}


def valid_runner_id(runner_id: str | None) -> bool:
    return bool(runner_id) and bool(_RUNNER_ID_RE.match(runner_id or ""))


def job_name_for(runner_id: str, label: str) -> str:
    return f"{RUNNER_PREFIX}{runner_id}:{label}"


def owner_of(job_name: str) -> str | None:
    """The runner id a job name carries, or None when it is not a runner job."""
    if not job_name.startswith(RUNNER_PREFIX):
        return None
    parts = job_name[len(RUNNER_PREFIX):].split(":", 1)
    if len(parts) != 2:
        return None
    runner_id, label = parts
    if not valid_runner_id(runner_id) or not _LABEL_RE.match(label):
        return None
    return runner_id


def _inside(path: str, root: Path, cwd: Path | None, *, is_dir: bool = False) -> Path | None:
    """The resolved path when it names an existing file (or, with is_dir, a
    directory) inside root, else None. A relative path is taken from cwd; with
    no known cwd a relative path is refused. Existence is required so a string
    that is not a path at all (an inline program, a module name) can never pass
    as one merely by resolving under root."""
    candidate = Path(path)
    if not candidate.is_absolute():
        if cwd is None:
            return None
        candidate = cwd / candidate
    try:
        resolved = resolve_within_root(str(candidate), root=root)
    except PathNotAllowed:
        return None
    exists = resolved.is_dir() if is_dir else resolved.is_file()
    return resolved if exists else None


def _check(command: str, root: Path, cwd: Path | None) -> tuple[str | None, Path | None]:
    """command_fault, also returning the working directory after the command,
    so a `cd` moves where later relative paths are read from."""
    if len(command) > MAX_RUNNER_COMMAND_CHARS:
        return f"A command is longer than {MAX_RUNNER_COMMAND_CHARS} characters.", cwd
    if any(ch in _SHELL_METACHARACTERS for ch in command):
        return f"The command {command!r} carries a shell metacharacter; send one plain command per line.", cwd
    try:
        tokens = shlex.split(command)
    except ValueError as exc:
        return f"The command {command!r} does not parse ({exc}).", cwd
    if not tokens:
        return "A command is empty.", cwd
    if any(ch in _SHELL_METACHARACTERS for token in tokens for ch in token):
        return f"The command {command!r} carries a shell metacharacter; send one plain command per line.", cwd
    head, args = tokens[0], tokens[1:]
    if head == "cd":
        if len(args) != 1:
            return "A cd takes exactly one directory.", cwd
        target = _inside(args[0], root, cwd, is_dir=True)
        if target is None:
            return f"The directory {args[0]!r} is not a directory inside the CMT checkout.", cwd
        return None, target
    if head in _INTERPRETERS:
        flags = []
        for arg in args:
            if not arg.startswith("-"):
                break
            flags.append(arg)
        unsafe = [flag for flag in flags if flag not in _SAFE_INTERPRETER_FLAGS]
        if unsafe:
            return (
                f"The interpreter flag {unsafe[0]!r} is not allowed; "
                "a runner runs a script file, not inline code or a module.",
                cwd,
            )
        if len(flags) == len(args):
            return f"The command {command!r} names an interpreter but no script to run.", cwd
        script = args[len(flags)]
        if _inside(script, root, cwd) is None:
            return f"The script {script!r} is not a file inside the CMT checkout.", cwd
        return None, cwd
    if "/" in head:
        if _inside(head, root, cwd) is None:
            return f"The program {head!r} is not a file inside the CMT checkout.", cwd
        return None, cwd
    return (
        f"The command {command!r} does not run a script in the CMT checkout; "
        "start it with a path inside the checkout, or with python, python3, bash or sh and such a path.",
        cwd,
    )


def command_fault(command: str, root: Path, project_dir: Path | None) -> str | None:
    """Why one command line is refused, or None.

    A command may only run a script inside the CMT checkout: its first token is
    a file inside root, or it is one of the interpreters above, with only the
    harmless flags, followed by a file inside root. `cd` is allowed only to a
    directory inside root. A relative path is read from project_dir.
    """
    return _check(command, root, project_dir)[0]


def allocation_fault(request, runner_id: str, root: Path) -> str | None:
    """Why a runner-key allocation is refused, or None. `request` is main.py's
    AllocationRequest."""
    owner = owner_of(request.job_name)
    if owner is None:
        return (
            f"A runner's job must be named {RUNNER_PREFIX}<runner id>:<label>, "
            f"not {request.job_name!r}."
        )
    if owner != runner_id:
        return f"The job name {request.job_name!r} belongs to another runner, not {runner_id}."
    if request.count > MAX_RUNNER_COUNT:
        return f"A runner may ask for at most {MAX_RUNNER_COUNT} GPUs in one request, the hard maximum no ruling raises."
    if request.time_mins > MAX_RUNNER_MINUTES:
        return f"A runner may ask for at most {MAX_RUNNER_MINUTES} minutes in one request, the hard maximum no ruling raises."
    if request.memory_mb > MAX_RUNNER_MEMORY_MB:
        return f"A runner may ask for at most {MAX_RUNNER_MEMORY_MB} MB of memory in one request, the hard maximum no ruling raises."
    if len(request.commands) > MAX_RUNNER_COMMANDS:
        return f"A runner may send at most {MAX_RUNNER_COMMANDS} commands in one request."
    cwd: Path | None = None
    if request.project_dir:
        cwd = _inside(request.project_dir, root, None, is_dir=True)
        if cwd is None:
            return f"The project directory {request.project_dir!r} is not a directory inside the CMT checkout."
    for command in request.commands:
        if not command.strip():
            continue
        fault, cwd = _check(command, root, cwd)
        if fault:
            return fault
    return None


def cancel_fault(job_id: str, jobs, runner_id: str) -> str | None:
    """Why a runner-key cancel is refused, or None. `jobs` is get_user_jobs()."""
    job = next((job for job in jobs if job.job_id == job_id), None)
    if job is None:
        return f"Job {job_id} is not in this account's job list."
    owner = owner_of(job.job_name)
    if owner != runner_id:
        return f"Job {job_id} ({job.job_name}) is not this runner's job."
    return None
