import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import kaava_idle  # noqa: E402

# Port 8765 is 0x223D. Line 1 is ESTABLISHED on 8765, line 2 LISTENs on 22 (must not count).
TCP = """  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:223D 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000     0        0 1 1
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1
"""
# Port 9000 (0x2328) ESTABLISHED over IPv6.
TCP6 = """  sl  local_address                         remote_address                        st tx_queue rx_queue
   0: 00000000000000000000000001000000:2328 00000000000000000000000001000000:C001 01 00000000:00000000
"""

CONF = """
# plane-vm
PORTS=8765            # ports whose traffic counts as activity
IDLE_MINUTES=30
MIN_UPTIME_MINUTES=20
EXTRA_CHECK=
ACTIVITY_COMMAND="docker logs --since {minutes}m plane-proxy-1"
PRE_STOP='docker compose stop'
"""


def config(**overrides):
    c = dict(kaava_idle.DEFAULTS, PORTS="8765")
    c.update(overrides)
    return c


class ParseConfig(unittest.TestCase):
    def test_values_comments_and_quotes(self):
        c = kaava_idle.parse_config(CONF)
        self.assertEqual(c["PORTS"], "8765")
        self.assertEqual(c["IDLE_MINUTES"], "30")
        self.assertEqual(c["EXTRA_CHECK"], "")
        self.assertEqual(c["ACTIVITY_COMMAND"], "docker logs --since {minutes}m plane-proxy-1")
        self.assertEqual(c["PRE_STOP"], "docker compose stop")
        self.assertEqual(c["DRY_RUN"], "0")

    def test_port_lists(self):
        self.assertEqual(kaava_idle.parse_ports("8765, 22 9000"), {8765, 22, 9000})
        self.assertEqual(kaava_idle.parse_ports(""), set())


class ProcNet(unittest.TestCase):
    def test_established_only_both_families(self):
        self.assertEqual(kaava_idle.established_ports([TCP, TCP6]), {8765, 9000})

    def test_listen_does_not_count(self):
        self.assertNotIn(22, kaava_idle.established_ports([TCP]))

    def test_conntrack_sees_nat_flows(self):
        text = (
            "ipv4 2 tcp 6 431999 ESTABLISHED src=35.235.241.9 dst=10.10.0.5 sport=50022"
            " dport=8765 src=172.18.0.9 dst=35.235.241.9 sport=80 dport=50022 [ASSURED] mark=0 use=1\n"
            "ipv4 2 tcp 6 110 TIME_WAIT src=35.235.241.9 dst=10.10.0.5 sport=50023 dport=9999"
            " src=10.10.0.5 dst=35.235.241.9 sport=9999 dport=50023 [ASSURED] mark=0 use=1\n"
            "ipv4 2 udp 17 29 src=10.10.0.5 dst=169.254.169.254 sport=5353 dport=53 use=1\n"
        )
        self.assertEqual(kaava_idle.conntrack_ports(text), {8765})


class Decide(unittest.TestCase):
    def test_young_vm_is_busy(self):
        busy, reason = kaava_idle.decide(config(), 5, set(), "", False)
        self.assertTrue(busy)
        self.assertIn("uptime", reason)

    def test_connection_on_watched_port(self):
        busy, reason = kaava_idle.decide(config(), 60, {8765}, "", False)
        self.assertTrue(busy)
        self.assertIn("8765", reason)

    def test_connection_on_other_port_is_ignored(self):
        busy, _ = kaava_idle.decide(config(), 60, {22}, "", False)
        self.assertFalse(busy)

    def test_activity_output(self):
        busy, reason = kaava_idle.decide(config(), 60, set(), "GET / 200\n", False)
        self.assertTrue(busy)
        self.assertIn("activity", reason)

    def test_blank_activity_is_idle(self):
        self.assertFalse(kaava_idle.decide(config(), 60, set(), "  \n", False)[0])

    def test_extra_check(self):
        busy, reason = kaava_idle.decide(config(), 60, set(), "", True)
        self.assertTrue(busy)
        self.assertIn("EXTRA_CHECK", reason)

    def test_idle(self):
        busy, reason = kaava_idle.decide(config(), 60, set(), "", False)
        self.assertFalse(busy)
        self.assertIn("no activity", reason)


class Check(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp()
        os.close(fd)
        self.addCleanup(os.remove, self.path)
        for name, value in [
            ("read_uptime_minutes", 60),
            ("read_open_ports", set()),
            ("log", None),
        ]:
            patcher = mock.patch.object(kaava_idle, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def write(self, text):
        with open(self.path, "w") as f:
            f.write(text)

    def calls(self, run):
        return [c.args[0] for c in run.call_args_list]

    def test_pre_stop_failure_still_shuts_down(self):
        self.write("PORTS=8765\nPRE_STOP=false\n")
        with mock.patch.object(kaava_idle.subprocess, "run") as run:
            run.return_value = subprocess.CompletedProcess([], 1)
            kaava_idle.check(self.path)
        self.assertEqual(self.calls(run), ["false", ["shutdown", "-h", "now"]])

    def test_pre_stop_exception_still_shuts_down(self):
        self.write("PORTS=8765\nPRE_STOP=docker compose stop\n")

        def run(cmd, **kwargs):
            if cmd == "docker compose stop":
                raise subprocess.TimeoutExpired(cmd, 300)
            return subprocess.CompletedProcess(cmd, 0)

        with mock.patch.object(kaava_idle.subprocess, "run", side_effect=run) as m:
            kaava_idle.check(self.path)
        self.assertEqual(self.calls(m)[-1], ["shutdown", "-h", "now"])

    def test_dry_run_does_not_shut_down(self):
        self.write("PORTS=8765\nDRY_RUN=1\nPRE_STOP=docker compose stop\n")
        with mock.patch.object(kaava_idle.subprocess, "run") as run:
            kaava_idle.check(self.path)
        run.assert_not_called()

    def test_busy_does_not_shut_down(self):
        self.write("PORTS=8765\nACTIVITY_COMMAND=docker logs --since {minutes}m plane-proxy-1\n")
        with mock.patch.object(kaava_idle.subprocess, "run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, stdout="GET /\n", stderr="")
            kaava_idle.check(self.path)
        self.assertEqual(self.calls(run), ["docker logs --since 30m plane-proxy-1"])

    def test_missing_config_stays_up(self):
        with mock.patch.object(kaava_idle.subprocess, "run") as run:
            kaava_idle.check(self.path + ".missing")
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
