"""POSIX PTY cancel/cleanup semantics. The 'leader' is a shell standing in for the Pi child started by a mux (pty.fork => session leader
with a controlling terminal). Two grandchildren: one in the leader's process group (like a non-detached spawn), one in its own session
(like a detached spawn). Each scenario kills the leader differently and reports who survives."""
import os, pty, signal, sys, tempfile, time

def state(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            rest = f.read().rsplit(") ", 1)[1].split()
        return rest[0]  # R/S/D/Z...
    except (FileNotFoundError, ProcessLookupError):
        return None

def alive(pid):
    s = state(pid)
    return s is not None and s != "Z"

def ids(pid):
    with open(f"/proc/{pid}/stat") as f:
        rest = f.read().rsplit(") ", 1)[1].split()
    return {"pgrp": int(rest[2]), "sid": int(rest[3])}

LEADER_STAY = "sleep 300 & echo $! > $D/same; setsid sleep 301 & echo $! > $D/own; wait"
LEADER_EXIT = "sleep 300 & echo $! > $D/same; setsid sleep 301 & echo $! > $D/own; sleep 1; exit 0"

def start(script):
    d = tempfile.mkdtemp()
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["D"] = d
        os.execvp("sh", ["sh", "-c", script])
    for _ in range(100):
        if os.path.exists(f"{d}/same") and os.path.exists(f"{d}/own") and os.path.getsize(f"{d}/own") > 0:
            break
        time.sleep(0.05)
    time.sleep(0.2)
    same = int(open(f"{d}/same").read()); own = int(open(f"{d}/own").read())
    return pid, fd, same, own

def reap(pid, timeout=2.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return "gone"
        if done:
            return f"exited code={os.waitstatus_to_exitcode(status)}"
        time.sleep(0.05)
    return "still running"

results = []
leaked = []

def scenario(name, script, action):
    pid, fd, same, own = start(script)
    lead = ids(pid)
    pre = f"leader pgrp={lead['pgrp']} sid={lead['sid']}; same-group child pgrp={ids(same)['pgrp']}; own-session child sid={ids(own)['sid']}"
    outcome = action(pid, fd, lead["pgrp"])
    time.sleep(0.8)
    row = (name, outcome, "alive" if alive(same) else "dead", "alive" if alive(own) else "dead")
    results.append(row)
    print(f"-- {name}\n   {pre}\n   leader: {outcome}; same-group grandchild: {row[2]}; own-session grandchild: {row[3]}")
    for g in (same, own):
        if alive(g):
            leaked.append(g)
    try:
        os.close(fd)
    except OSError:
        pass

def a_exit_clean(pid, fd, pg): return reap(pid, 4.0)
def b_master_close(pid, fd, pg):
    os.close(fd); return reap(pid)
def c_sigterm_leader(pid, fd, pg):
    os.kill(pid, signal.SIGTERM); return reap(pid)
def d_sigkill_leader(pid, fd, pg):
    os.kill(pid, signal.SIGKILL); return reap(pid)
def e_kill_group(pid, fd, pg):
    os.killpg(pg, signal.SIGTERM); return reap(pid)
def f_sighup_leader(pid, fd, pg):
    os.kill(pid, signal.SIGHUP); return reap(pid)

scenario("A leader exits on its own (clean exit)", LEADER_EXIT, a_exit_clean)
scenario("B mux closes the pty master (hangup)", LEADER_STAY, b_master_close)
scenario("C SIGTERM to the leader pid only", LEADER_STAY, c_sigterm_leader)
scenario("D SIGKILL to the leader pid only", LEADER_STAY, d_sigkill_leader)
scenario("E SIGTERM to the leader's process group (kill -pgid)", LEADER_STAY, e_kill_group)
scenario("F SIGHUP to the leader pid only", LEADER_STAY, f_sighup_leader)

for pid in leaked:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
print(f"\nleaked grandchildren killed by the harness: {len(leaked)}")
