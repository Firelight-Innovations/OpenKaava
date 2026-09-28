#!/usr/bin/env python3
"""Stop this VM when nothing has used it for a while (OPENKAAVA-PLANE-DESIGN.md §5.1).

    kaava-idle check                 what the systemd timer runs
    kaava-idle install [--interval]  install the command, the unit and the timer

Generic across VMs: each VM describes its own activity in /etc/kaava-idle.conf.
"""

import argparse
import os
import shutil
import subprocess
import sys

CONFIG_PATH = "/etc/kaava-idle.conf"
INSTALL_PATH = "/usr/local/bin/kaava-idle"
UNIT_DIR = "/etc/systemd/system"

DEFAULTS = {
    "PORTS": "",
    "IDLE_MINUTES": "30",
    "MIN_UPTIME_MINUTES": "20",
    "EXTRA_CHECK": "",
    "ACTIVITY_COMMAND": "",
    "PRE_STOP": "",
    "DRY_RUN": "0",
}

TCP_ESTABLISHED = "01"


def parse_config(text):
    """Shell-style KEY=VALUE lines. Quotes around a value are stripped; `#` starts a comment line."""
    config = dict(DEFAULTS)
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        # An unquoted value may carry a trailing comment, as in the design document's example.
        if value[:1] in ("'", '"') and value[-1:] == value[:1] and len(value) >= 2:
            value = value[1:-1]
        elif " #" in value or "\t#" in value:
            value = value.split("#", 1)[0].strip()
        config[key.strip()] = value
    return config


def parse_ports(value):
    return {int(p) for p in value.replace(",", " ").split() if p.strip()}


def established_ports(proc_texts):
    """Local ports with an ESTABLISHED connection, from /proc/net/tcp and tcp6 contents."""
    ports = set()
    for text in proc_texts:
        for line in text.splitlines()[1:]:
            fields = line.split()
            if len(fields) < 4 or fields[3] != TCP_ESTABLISHED:
                continue
            ports.add(int(fields[1].rsplit(":", 1)[1], 16))
    return ports


def conntrack_ports(text):
    """Destination ports of ESTABLISHED TCP flows in /proc/net/nf_conntrack.

    Docker publishes a container port through NAT, so a connection to it lives in the
    container's network namespace and never shows in the host's /proc/net/tcp. The host's
    connection tracking still sees the flow; the first dport= is the original destination.
    """
    ports = set()
    for line in text.splitlines():
        fields = line.split()
        if "tcp" not in fields or "ESTABLISHED" not in fields:
            continue
        for field in fields:
            if field.startswith("dport="):
                ports.add(int(field[6:]))
                break
    return ports


def decide(config, uptime_minutes, open_ports, activity_output, extra_check_busy):
    """The whole busy/idle decision, with every observation passed in. Returns (busy, reason)."""
    min_uptime = float(config["MIN_UPTIME_MINUTES"])
    if uptime_minutes < min_uptime:
        return True, f"uptime {uptime_minutes:.0f} min is under MIN_UPTIME_MINUTES={min_uptime:g}"
    watched = parse_ports(config["PORTS"]) & open_ports
    if watched:
        return True, "established connection on port " + ",".join(map(str, sorted(watched)))
    if activity_output and activity_output.strip():
        return True, f"activity in the last {config['IDLE_MINUTES']} min"
    if extra_check_busy:
        return True, "EXTRA_CHECK reports busy"
    return False, f"no activity for {config['IDLE_MINUTES']} min"


def log(message):
    line = f"kaava-idle: {message}"
    print(line, flush=True)
    # stdout reaches the journal under systemd; logger also tags it for anyone grepping syslog.
    try:
        subprocess.run(["logger", "-t", "kaava-idle", message], check=False, timeout=5)
    except (OSError, subprocess.SubprocessError):
        pass


def read_uptime_minutes():
    with open("/proc/uptime") as f:
        return float(f.read().split()[0]) / 60


def read_file(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def read_open_ports():
    local = established_ports([read_file("/proc/net/tcp"), read_file("/proc/net/tcp6")])
    return local | conntrack_ports(read_file("/proc/net/nf_conntrack"))


def run_activity(config):
    command = config["ACTIVITY_COMMAND"]
    if not command:
        return ""
    command = command.replace("{minutes}", config["IDLE_MINUTES"])
    result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=60)
    # docker logs writes the proxy's access log to stderr as well as stdout.
    return (result.stdout or "") + (result.stderr or "")


def run_extra_check(config):
    command = config["EXTRA_CHECK"]
    if not command:
        return False
    return subprocess.run(command, shell=True, timeout=60).returncode == 0


def stop(config):
    pre_stop = config["PRE_STOP"]
    if pre_stop:
        log(f"running PRE_STOP: {pre_stop}")
        try:
            code = subprocess.run(pre_stop, shell=True, timeout=300).returncode
            if code != 0:
                log(f"PRE_STOP exited {code}; stopping anyway")
        except (OSError, subprocess.SubprocessError) as err:
            log(f"PRE_STOP failed ({err}); stopping anyway")
    log("shutting down")
    subprocess.run(["shutdown", "-h", "now"], check=False)


def check(config_path):
    try:
        with open(config_path) as f:
            config = parse_config(f.read())
    except OSError as err:
        log(f"no config at {config_path} ({err}); staying up")
        return 0
    busy, reason = decide(
        config,
        read_uptime_minutes(),
        read_open_ports(),
        run_activity(config),
        run_extra_check(config),
    )
    if busy:
        log(f"busy: {reason}")
        return 0
    if config["DRY_RUN"] == "1":
        log(f"idle: {reason} (DRY_RUN, not stopping)")
        return 0
    log(f"idle: {reason}")
    stop(config)
    return 0


SERVICE_UNIT = """[Unit]
Description=Stop this VM when it has been idle (kaava-idle)

[Service]
Type=oneshot
ExecStart={path} check
"""

TIMER_UNIT = """[Unit]
Description=Check this VM for idleness (kaava-idle)

[Timer]
OnBootSec=5min
OnUnitActiveSec={interval}

[Install]
WantedBy=timers.target
"""


def install(interval):
    source = os.path.abspath(__file__)
    if source != INSTALL_PATH:
        shutil.copyfile(source, INSTALL_PATH)
    os.chmod(INSTALL_PATH, 0o755)
    with open(os.path.join(UNIT_DIR, "kaava-idle.service"), "w") as f:
        f.write(SERVICE_UNIT.format(path=INSTALL_PATH))
    with open(os.path.join(UNIT_DIR, "kaava-idle.timer"), "w") as f:
        f.write(TIMER_UNIT.format(interval=interval))
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "--now", "kaava-idle.timer"], check=True)
    if not os.path.exists(CONFIG_PATH):
        print(f"kaava-idle: installed; write {CONFIG_PATH} or every check stays up")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="kaava-idle")
    sub = parser.add_subparsers(dest="command", required=True)
    p_check = sub.add_parser("check", help="stop the VM if it is idle")
    p_check.add_argument("--config", default=CONFIG_PATH)
    p_install = sub.add_parser("install", help="install the command and the systemd timer")
    p_install.add_argument("--interval", default="5min")
    args = parser.parse_args(argv)
    if args.command == "check":
        return check(args.config)
    return install(args.interval)


if __name__ == "__main__":
    sys.exit(main())
