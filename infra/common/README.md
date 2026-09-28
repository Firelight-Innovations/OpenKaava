# infra/common

Small tools that any OpenKaava VM can use. Both are single-file, standard-library Python 3.12
scripts, so they need no install step beyond copying the file. The spec is
`docs/design/OPENKAAVA-PLANE-DESIGN.md` §3.3 and §5.

| Tool                               | Installed as                | Purpose                                                   |
| ---------------------------------- | --------------------------- | --------------------------------------------------------- |
| `kaava-idle/kaava_idle.py`         | `/usr/local/bin/kaava-idle` | Stops the VM it runs on when nothing has used it for a while |
| `kaava-wake/kaava_wake.py`         | `/usr/local/bin/kaava-wake` | Starts a stopped service VM and waits until it is healthy |

## kaava-idle

```sh
sudo python3 kaava_idle.py install            # command, systemd unit, timer (every 5 min)
sudo tee /etc/kaava-idle.conf <<'EOF'
PORTS=8765
IDLE_MINUTES=30
MIN_UPTIME_MINUTES=20
ACTIVITY_COMMAND=docker logs --since {minutes}m plane-proxy-1
PRE_STOP=docker compose -p plane stop
EOF
sudo kaava-idle check                         # one decision now; the timer runs the same
```

The timer does nothing until the config exists. Each check writes one line that says busy or
idle and why. When the VM is idle, the check runs `PRE_STOP` and then `shutdown -h now`.
`PRE_STOP` can fail and the shutdown still happens.

| Key                  | Default | Meaning                                                                    |
| -------------------- | ------- | -------------------------------------------------------------------------- |
| `PORTS`              | none    | Any ESTABLISHED TCP connection on these ports counts as busy. The check also reads conntrack, so Docker-published ports count too |
| `IDLE_MINUTES`       | 30      | How long without activity before the VM stops                              |
| `MIN_UPTIME_MINUTES` | 20      | The VM never stops sooner than this after boot                             |
| `ACTIVITY_COMMAND`   | none    | Busy if it prints anything. `{minutes}` becomes `IDLE_MINUTES`             |
| `EXTRA_CHECK`        | none    | Busy if it exits 0                                                         |
| `PRE_STOP`           | none    | Runs before shutdown, for example a clean database stop                   |
| `DRY_RUN`            | 0       | `1` logs the decision but never stops the VM                               |

## kaava-wake

```sh
sudo install -m 755 kaava_wake.py /usr/local/bin/kaava-wake
kaava-wake plane          # exit 0 once healthy; exit 1 with the last error on timeout
```

The tool starts the VM if it is stopped and resumes it if it is suspended. If the VM is
stopping, the tool waits for the stop to finish first. It waits up to 120 s for `RUNNING`, then
up to 240 s for every health URL to return 200. It authenticates with the VM's service account
through the metadata server, or with `gcloud` elsewhere. The caller needs the `kaavaWaker` role
on the instance.

`plane` is built in. Add other services in `/etc/kaava/services.json`:

```json
{ "name": { "instance": "vm-name", "zone": "us-central1-a", "health": ["http://host:port/"] } }
```

As a library: `from kaava_wake import wake; seconds = wake("plane")`. It raises `WakeError` on
timeout.

## Tests

```sh
python -m unittest discover -s infra/common/kaava-idle -v
python -m unittest discover -s infra/common/kaava-wake -v
```
