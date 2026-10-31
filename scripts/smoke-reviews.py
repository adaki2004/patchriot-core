#!/usr/bin/env python3
"""Real relay/dispatcher fixture review, including a deliberately lost result reply."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import urllib.request
import urllib.error
import uuid


def main():
    origin = "http://127.0.0.1:7411"
    secret = os.environ["PATCHRIOT_INTERNAL_KEY"]
    audience = os.environ["PATCHRIOT_AUDIENCE"]
    relay = Path(__file__).resolve().parents[2] / "patchriot-relay/target/debug/patchriot-relay"
    owner, admin = str(uuid.uuid4()), str(uuid.uuid4())
    devices = []
    drop_lock = threading.Lock()
    drop_next_result = True

    class Proxy(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            nonlocal drop_next_result
            length = int(self.headers.get("Content-Length", "0"))
            if length > 16384:
                self.send_error(413)
                return
            body = self.rfile.read(length)
            connection = http.client.HTTPConnection("127.0.0.1", 7411, timeout=10)
            try:
                connection.request("POST", self.path, body=body, headers={"Content-Type": "application/json"})
                response = connection.getresponse()
                data = response.read(16385)
                with drop_lock:
                    drop = drop_next_result and self.path.endswith("/work/complete") and response.status == 200
                    if drop:
                        drop_next_result = False
                if drop:
                    self.close_connection = True
                    return  # The real server committed, but the client receives no reply.
                self.send_response(response.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            finally:
                connection.close()

    def api(path, body=None, role="member", actor_id=None):
        actor_id = actor_id or (admin if role == "admin" else owner)
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {secret}", "X-Patchriot-Account": actor_id, "X-Patchriot-Role": role}
        request = urllib.request.Request(origin + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    def run(state, action, *args, expected=0):
        env = {name: os.environ[name] for name in ("PATH", "HOME", "TMPDIR") if name in os.environ}
        result = subprocess.run([str(relay), action, "--state-dir", str(state), *args], capture_output=True, text=True, timeout=25, env=env)
        if result.returncode != expected:
            raise RuntimeError(f"relay {action} failed: exit {result.returncode}; {result.stderr}")
        return [json.loads(line) for line in result.stdout.splitlines() if line]

    proxy = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    thread = threading.Thread(target=proxy.serve_forever, daemon=True)
    thread.start()
    group = f"review-smoke-{uuid.uuid4()}"
    review = None
    try:
        with tempfile.TemporaryDirectory(prefix="patchriot-review-smoke-") as temporary:
            states = [Path(temporary) / f"relay-{i}" for i in range(3)]
            try:
                for i, state in enumerate(states):
                    run(state, "init", "--dispatcher", f"http://127.0.0.1:{proxy.server_port}", "--audience", audience, "--label", f"Review smoke {i + 1}", "--compute-group", group)
                    pairing = run(state, "pair")[0]
                    claimed = api("/internal/pairings/claim", {"user_code": pairing["user_code"], "display_name": "Review smoke operator", "hosting": "own_machine", "accepts_private_work_rules": True})
                    device = claimed["device_id"]
                    devices.append(device)
                    api(f"/internal/devices/{device}/decision", {"action": "approve", "reason": "Owned-fixture smoke test"}, "admin")
                request_id = str(uuid.uuid4())
                review = api("/internal/reviews", {"request_id": request_id, "scenario": "access_control_v1"})
                assert api("/internal/reviews", {"request_id": request_id, "scenario": "access_control_v1"})["id"] == review["id"]
                run(states[0], "connect", "--once", "--fixtures", expected=1)
                saved = json.loads((states[0] / "relay.json").read_text())
                assert saved["pending_result"] is not None
                retry = run(states[0], "connect", "--once", "--fixtures")
                assert any(event.get("replayed") is True for event in retry)
                assert json.loads((states[0] / "relay.json").read_text())["pending_result"] is None
                for state in states[1:]:
                    events = run(state, "connect", "--once", "--fixtures")
                    assert any(event.get("fixture_matches") is True for event in events)
                report = api(f"/internal/reviews/{review['id']}")
                assert report["state"] == "completed"
                assert len(report["steps"]) == 3
                assert all(step["fixture_matches"] is True for step in report["steps"])
                assert len({step["device_id"] for step in report["steps"]}) == 3
                assert len({step["operator_id"] for step in report["steps"]}) == 1
                assert len({step["compute_group"] for step in report["steps"]}) == 1
                try:
                    api(f"/internal/reviews/{review['id']}", actor_id=str(uuid.uuid4()))
                    raise AssertionError("unrelated account could read report")
                except urllib.error.HTTPError as error:
                    assert error.code == 404
                print(json.dumps({"passed": True, "review_id": report["id"], "devices": 3, "operators": 1, "compute_groups": 1, "real_model_calls": 0, "checks": ["queued three-role fixture", "original/patch/control", "durable outbox", "lost response replay", "private report"]}))
            finally:
                if review:
                    latest = api(f"/internal/reviews/{review['id']}")
                    if latest["state"] in ("queued", "running"):
                        api(f"/internal/reviews/{review['id']}/cancel", {})
                for device in devices:
                    api(f"/internal/devices/{device}/decision", {"action": "revoke", "reason": "Smoke test complete"})
    finally:
        proxy.shutdown()
        proxy.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    main()
