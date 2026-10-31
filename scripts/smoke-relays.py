#!/usr/bin/env python3
"""Exercise real relay binaries against a local dispatcher, without model calls."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request
import uuid


def main():
    origin = "http://127.0.0.1:7411"
    secret = os.environ["PATCHRIOT_INTERNAL_KEY"]
    audience = os.environ["PATCHRIOT_AUDIENCE"]
    relay = Path(__file__).resolve().parents[2] / "patchriot-relay/target/debug/patchriot-relay"
    owner, admin = str(uuid.uuid4()), str(uuid.uuid4())
    devices = []

    def api(path, body=None, role=None):
        headers = {"Content-Type": "application/json"}
        if role:
            headers.update({"Authorization": f"Bearer {secret}", "X-Patchriot-Account": admin if role == "admin" else owner, "X-Patchriot-Role": role})
        request = urllib.request.Request(origin + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    def run(state, action, *args, expected=0):
        result = subprocess.run([str(relay), action, "--state-dir", str(state), *args], capture_output=True, text=True, timeout=20)
        if result.returncode != expected:
            raise RuntimeError(f"relay {action} failed with exit {result.returncode}; stderr: {result.stderr}")
        return json.loads(result.stdout) if result.stdout else None

    baseline = api("/v1/fleet")
    with tempfile.TemporaryDirectory(prefix="patchriot-live-smoke-") as temporary:
        states = [Path(temporary) / f"relay-{i}" for i in range(3)]
        try:
            for i, state in enumerate(states):
                run(state, "init", "--dispatcher", origin, "--audience", audience, "--label", f"Smoke fixture {i + 1}", "--compute-group", "smoke-shared-host")
                pairing = run(state, "pair")
                claimed = api("/internal/pairings/claim", {"user_code": pairing["user_code"], "display_name": "Local smoke-test operator", "hosting": "own_machine", "accepts_private_work_rules": True}, "member")
                device_id = claimed["device_id"]
                devices.append(device_id)
                assert run(state, "connect", "--once")["state"] == "awaiting_approval"
                api(f"/internal/devices/{device_id}/decision", {"action": "approve", "reason": "Owned-fixture smoke test"}, "admin")
                assert run(state, "connect", "--once")["state"] == "online"
            fleet = api("/v1/fleet")
            assert fleet["online_devices"] == baseline["online_devices"] + 3
            assert fleet["online_operators"] == baseline["online_operators"] + 1
            assert fleet["online_compute_groups"] == baseline["online_compute_groups"] + 1
            run(states[0], "pause")
            assert run(states[0], "connect", "--once")["state"] == "paused"
            assert api("/v1/fleet")["online_devices"] == baseline["online_devices"] + 2
            run(states[0], "resume")
            assert run(states[0], "connect", "--once")["state"] == "online"
            api(f"/internal/devices/{devices[0]}/decision", {"action": "revoke", "reason": "Check revocation"}, "member")
            run(states[0], "connect", "--once", expected=1)
            print(json.dumps({"passed": True, "relay_instances": 3, "operators": 1, "compute_groups": 1, "checks": ["pair", "claim", "manual approval", "heartbeat", "pause", "resume", "revoke"]}))
        finally:
            for device_id in devices:
                api(f"/internal/devices/{device_id}/decision", {"action": "revoke", "reason": "Smoke test complete"}, "member")


if __name__ == "__main__":
    main()
