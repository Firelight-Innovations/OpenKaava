#!/usr/bin/env python3
"""Start a stopped service VM and wait until it answers (OPENKAAVA-PLANE-DESIGN.md §3.3).

    kaava-wake plane            exits 0 once every health check returns 200, 1 on timeout

Also a library: `from kaava_wake import wake`. Stdlib only, so it runs on any VM image.
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

COMPUTE = "https://compute.googleapis.com/compute/v1"
METADATA = "http://metadata.google.internal/computeMetadata/v1"
SERVICES_PATH = "/etc/kaava/services.json"
DEFAULT_ZONE = "us-central1-a"

POLL_SECONDS = 3
RUNNING_TIMEOUT = 120
HEALTH_TIMEOUT = 240

PLANE_URL = "http://plane.kaava.internal:8765"
SERVICES = {
    "plane": {
        "instance": "plane-vm",
        "health": [f"{PLANE_URL}/", f"{PLANE_URL}/api/instances/"],
    },
}

# Swapped out by the tests.
now = time.monotonic
sleep = time.sleep


class WakeError(Exception):
    pass


def http(method, url, headers=None, timeout=10):
    """One HTTP request. Returns (status, body); network failures raise OSError."""
    req = urllib.request.Request(url, method=method, headers=headers or {})
    if method == "POST":
        req.data = b""
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")


def metadata(path):
    try:
        status, body = http("GET", f"{METADATA}/{path}", {"Metadata-Flavor": "Google"}, timeout=1)
    except OSError:
        return None
    return body if status == 200 else None


def gcloud(*args):
    out = subprocess.run(["gcloud", *args], capture_output=True, text=True, check=True, shell=os.name == "nt")
    return out.stdout.strip()


def access_token():
    body = metadata("instance/service-accounts/default/token")
    if body:
        return json.loads(body)["access_token"]
    return gcloud("auth", "print-access-token")


def default_project():
    return os.environ.get("KAAVA_PROJECT") or metadata("project/project-id") or gcloud("config", "get-value", "project")


def load_services(path=SERVICES_PATH):
    services = dict(SERVICES)
    try:
        with open(path) as f:
            services.update(json.load(f))
    except FileNotFoundError:
        pass
    return services


class Instance:
    def __init__(self, project, zone, name, token):
        self.url = f"{COMPUTE}/projects/{project}/zones/{zone}/instances/{name}"
        self.headers = {"Authorization": f"Bearer {token}"}

    def call(self, method, suffix=""):
        status, body = http(method, self.url + suffix, self.headers)
        if status != 200:
            raise WakeError(f"{method} {self.url}{suffix}: HTTP {status}: {body[:300]}")
        return json.loads(body)

    def status(self):
        return self.call("GET")["status"]

    def start(self):
        self.call("POST", "/start")

    def resume(self):
        self.call("POST", "/resume")


def wait_running(instance, log, started):
    """Steps 1-2: start or resume as the current state needs, then wait for RUNNING."""
    deadline = now() + RUNNING_TIMEOUT
    asked = False
    while True:
        state = instance.status()
        if state == "RUNNING":
            return
        if not asked and state in ("TERMINATED", "STOPPED"):
            log(f"{state.lower()}; starting", started)
            instance.start()
            asked = True
        elif not asked and state == "SUSPENDED":
            log("suspended; resuming", started)
            instance.resume()
            asked = True
        else:
            # STOPPING and SUSPENDING must finish before the VM accepts start or resume.
            log(f"state {state}", started)
        if now() >= deadline:
            raise WakeError(f"not RUNNING after {RUNNING_TIMEOUT} s (last state {state})")
        sleep(POLL_SECONDS)


def wait_healthy(urls, log, started):
    """Step 3: every health URL returns 200."""
    deadline = now() + HEALTH_TIMEOUT
    last = "no check yet"
    while True:
        failing = []
        for url in urls:
            try:
                status, _ = http("GET", url, timeout=5)
            except OSError as err:
                failing.append(f"{url}: {err}")
                continue
            if status != 200:
                failing.append(f"{url}: HTTP {status}")
        if not failing:
            return
        last = "; ".join(failing)
        log(f"waiting for health: {last}", started)
        if now() >= deadline:
            raise WakeError(f"unhealthy after {HEALTH_TIMEOUT} s: {last}")
        sleep(POLL_SECONDS)


def stderr_log(message, started):
    print(f"kaava-wake [{now() - started:5.0f}s] {message}", file=sys.stderr, flush=True)


def quiet_log(message, started):
    pass


def wake(service, project=None, zone=None, log=stderr_log, services=None):
    """Bring `service` up and healthy. Returns the seconds it took; raises WakeError on timeout."""
    services = services if services is not None else load_services()
    if service not in services:
        raise WakeError(f"unknown service {service!r}; known: {', '.join(sorted(services))}")
    spec = services[service]
    started = now()
    zone = zone or spec.get("zone") or DEFAULT_ZONE
    instance = Instance(project or default_project(), zone, spec["instance"], access_token())
    wait_running(instance, log, started)
    wait_healthy(spec.get("health", []), log, started)
    return now() - started


def main(argv=None):
    parser = argparse.ArgumentParser(prog="kaava-wake")
    parser.add_argument("service")
    parser.add_argument("--project")
    parser.add_argument("--zone")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)
    log = quiet_log if args.quiet else stderr_log
    try:
        seconds = wake(args.service, args.project, args.zone, log)
    except (WakeError, OSError, subprocess.CalledProcessError) as err:
        print(f"kaava-wake: {err}", file=sys.stderr)
        return 1
    if not args.quiet:
        print(f"kaava-wake: {args.service} healthy in {seconds:.0f} s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
