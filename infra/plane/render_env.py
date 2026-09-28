#!/usr/bin/env python3
"""Render plane.env.tmpl into a Plane env file, filling secrets from Secret Manager.

    render_env.py --template plane.env.tmpl --out /run/plane/plane.env \\
        --prefix plane- --param web_url=http://plane.kaava.internal:8765 --param port=8765 ...

${SECRET:<name>} becomes the latest version of secret <prefix><name>; ${PARAM:<name>} becomes the
matching --param. An unfilled placeholder is an error, so a missing secret stops Plane from
starting rather than starting it with an empty password. The output is written mode 600, and the
caller puts it on a tmpfs: secrets are never written to a disk by this script.

Credentials: the GCE metadata server on a VM, `gcloud auth print-access-token` elsewhere.
"""

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import urllib.request

METADATA = "http://metadata.google.internal/computeMetadata/v1/"
PLACEHOLDER = re.compile(r"\$\{(SECRET|PARAM):([a-z0-9_-]+)\}")


def metadata(path):
    req = urllib.request.Request(METADATA + path, headers={"Metadata-Flavor": "Google"})
    try:
        with urllib.request.urlopen(req, timeout=1) as resp:
            return resp.read().decode()
    except OSError:
        return None


def gcloud(*args):
    # gcloud is a .cmd shim on Windows, which only the shell can start.
    out = subprocess.run(["gcloud", *args], capture_output=True, text=True, check=True,
                         shell=os.name == "nt")
    return out.stdout.strip()


def credentials(project):
    token = metadata("instance/service-accounts/default/token")
    if token is not None:
        return json.loads(token)["access_token"], project or metadata("project/project-id")
    return gcloud("auth", "print-access-token"), project or gcloud("config", "get-value", "project")


def secret(project, token, name):
    url = (f"https://secretmanager.googleapis.com/v1/projects/{project}"
           f"/secrets/{name}/versions/latest:access")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.load(resp)["payload"]["data"]
    except urllib.error.HTTPError as err:
        sys.exit(f"render_env: secret {name}: HTTP {err.code} {err.reason}")
    return base64.b64decode(data).decode().strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--template", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--prefix", default="plane-")
    ap.add_argument("--project")
    ap.add_argument("--param", action="append", default=[], metavar="NAME=VALUE")
    args = ap.parse_args()

    params = dict(p.split("=", 1) for p in args.param)
    template = open(args.template, encoding="utf-8").read()
    token, project = credentials(args.project)
    cache = {}

    def fill(match):
        kind, name = match.groups()
        if kind == "PARAM":
            if name not in params:
                sys.exit(f"render_env: no --param {name}")
            return params[name]
        if name not in cache:
            cache[name] = secret(project, token, args.prefix + name)
        return cache[name]

    rendered = PLACEHOLDER.sub(fill, template)
    fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as out:
        out.write(rendered)
    print(f"render_env: {args.out} ({len(cache)} secrets from {project})", file=sys.stderr)


if __name__ == "__main__":
    main()
