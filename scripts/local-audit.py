#!/usr/bin/env python3
"""Prepare or start a local HTTP-only audit through the normal website API.

Ownership is verified separately in the UI. Starting requires a coupon, explicit
consent and two eligible devices. The helper never approves ownership or retries
an uncertain checkout. Keep its state and credential files outside the checkout.
"""

import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import stat
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import uuid


MODELS = {
    "deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated": "near.ai",
    "deepseek-v4-1-flash-1017-uncensored": "venice.ai",
}


def private_text(path, limit=16384):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW)) as file:
        metadata = os.fstat(file.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077
                or metadata.st_uid != os.getuid() or metadata.st_size > limit):
            raise ValueError("Use an owner-only file (chmod 600), owned by your OS user")
        return file.read(limit + 1).strip()


def save_state(path, state, new=False):
    flags = os.O_WRONLY | os.O_NOFOLLOW | (os.O_CREAT | os.O_EXCL if new else 0)
    with os.fdopen(os.open(path, flags, 0o600), "w") as file:
        metadata = os.fstat(file.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077 or metadata.st_uid != os.getuid():
            raise ValueError("State must be an owner-only regular file")
        file.write(json.dumps(state, indent=2) + "\n")
        file.truncate()
        file.flush()
        os.fsync(file.fileno())


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, origin, username, password_file):
        parsed = urlsplit(origin)
        if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
                or not parsed.port or parsed.username or parsed.password
                or parsed.path or parsed.query or parsed.fragment):
            raise ValueError("--core must be an http://127.0.0.1:PORT origin")
        self.origin, self.csrf = origin, None
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
            urllib.request.ProxyHandler({}), NoRedirects(),
        )
        self.api("/auth/login", {"username": username, "password": private_text(password_file, 257)})
        self.csrf = self.api("/session")["csrf_token"]

    def api(self, path, body=None):
        headers = {"Origin": self.origin, "Content-Type": "application/json"}
        if self.csrf:
            headers["x-csrf-token"] = self.csrf
        request = urllib.request.Request(self.origin + "/api" + path, headers=headers,
                                         data=None if body is None else json.dumps(body).encode())
        try:
            with self.opener.open(request, timeout=30) as response:
                data = response.read(2 * 1024 * 1024 + 1)
                if len(data) > 2 * 1024 * 1024:
                    raise ValueError("Local API response exceeds the helper's limit")
                return json.loads(data)
        except urllib.error.HTTPError as error:
            # Never echo server bodies that might repeat submitted credentials.
            raise RuntimeError(f"Local API returned HTTP {error.code}; inspect the setup in the UI") from None


def prepare(client, args):
    if bool(args.login_path) != bool(args.check_path):
        raise ValueError("Supply both --login-path and --check-path, or neither for black box")
    scope = {
        "origins": [args.target], "profile": "web_baseline_v1",
        "methods": ["GET", "HEAD", "OPTIONS"],
        "tools": ["scoped_discovery_v1", "run_context_v1"],
        "check_groups": ["public_baseline"],
    }
    if args.login_path:
        scope.update(authentication="session", auth_check_path=args.check_path,
                     session_login={"path": args.login_path, "format": "json",
                                    "username_field": args.username_field, "password_field": args.password_field})
        scope["tools"] += ["authenticated_http_v1", "session_login_v1"]
    # Refuse accidental overwrite before creating a server-side setup.
    state = {"core": client.origin, "phase": "creating", "request_id": str(uuid.uuid4())}
    save_state(args.state, state, new=True)
    target = client.api("/pentests", {
        "request_id": state["request_id"], "scope": scope,
        "accepts_live_requests": True, "accepts_state_changes": False,
        "permission_note": "Local HTTP-only trial. Verify ownership before testing. Use disposable accounts; browser coverage is not included.",
    })
    state.update(phase="prepared", pentest_id=str(uuid.UUID(target["id"])), scope_sha256=target["scope_sha256"])
    save_state(args.state, state)
    print("Prepared only. Verify ownership in the UI before starting:")
    print(client.origin + "/#/pentests/" + state["pentest_id"])


def start(client, args):
    state = json.loads(private_text(args.state))
    if state["core"] != client.origin:
        raise ValueError("State belongs to a different local installation")
    if state.get("phase") != "prepared":
        raise ValueError("This state was already submitted or interrupted. Check Audits in the UI before doing anything else")
    if not args.accept_test_risk or not args.accept_private_processing:
        raise ValueError("Starting requires --accept-test-risk and --accept-private-processing")
    path = "/pentests/" + str(uuid.UUID(state["pentest_id"]))
    target = next((item for item in client.api("/pentests") if item["id"] == state["pentest_id"]), None)
    if target is None:
        raise ValueError("Prepared setup is not available to this account")
    if target["scope_sha256"] != state["scope_sha256"]:
        raise ValueError("Scope changed; inspect and finish this setup in the UI")
    if target["state"] != "approved" or not target.get("ownership_verified"):
        raise ValueError("Verify ownership in the UI first; the helper cannot approve it")
    if args.credentials_file:
        if target["scope"].get("authentication") != "session":
            raise ValueError("The prepared scope does not use JSON/cookie login")
        credentials = json.loads(private_text(args.credentials_file))
        if set(credentials) != {"username", "password"} or not all(isinstance(v, str) and v for v in credentials.values()):
            raise ValueError("Credential file must contain only nonempty username and password strings")
        client.api(path + "/credentials", {"scope_sha256": state["scope_sha256"], "credentials": {"kind": "session", **credentials}})
        target = next(item for item in client.api("/pentests") if item["id"] == state["pentest_id"])
    if not target.get("can_start"):
        raise ValueError("This setup is not ready; save test credentials or inspect it in the UI")
    plan = client.api(path + "/review-plan")
    devices = plan["recommended_device_ids"]
    # A small local example, deliberately not a second implementation of every policy.
    if (plan["scope_sha256"] != state["scope_sha256"] or len(devices) != 2
            or len(set(devices)) != 2
            or plan.get("recommended_review_policy") != "investigate_validate_v1"):
        raise ValueError("This helper needs the local fixed two-agent plan; use the UI for other team policies")
    team = [next((c for c in plan["candidates"] if c["device_id"] == device), None) for device in devices]
    if any(not member or member["declared_model"] not in MODELS for member in team):
        raise ValueError("No supported two-agent team is ready")
    fallback = plan.get("fallback_model")
    if not fallback and plan.get("venice_fallback_model"):
        raise ValueError("Use the current primary/secondary settings or finish in the UI")
    if fallback and (fallback not in MODELS or any(member["declared_model"] == fallback for member in team)):
        raise ValueError("Unsupported backup provider plan")
    consent = {"request_id": str(uuid.uuid4()), "scope_sha256": state["scope_sha256"], "device_ids": devices,
               "accepts_operator_access": True, "accepts_provider_access": True,
               "review_policy": "investigate_validate_v1"}
    if plan.get("recommended_worker_pool"):
        consent["use_worker_pool"] = True
    if fallback:
        consent["fallback_model"] = fallback
    coupon = private_text(args.coupon_file, 128)
    if len(coupon) != 67 or not coupon.startswith("pr-") or any(c not in "0123456789abcdef" for c in coupon[3:].lower()):
        raise ValueError("Coupon file must contain only the issued pr- code")
    print("Target:", ", ".join(target["scope"]["origins"]))
    for member in team:
        print("Agent:", member["device_id"], "Operator:", member["operator_id"], "Model:", member["declared_model"])
    print("Backup:", fallback or "none")
    if input("These operators/providers process private test data. A coupon still spends inference credit. Type START: ") != "START":
        print("Not started; no coupon was used.")
        return
    # Save before any checkout: a timeout must never cause another paid request.
    state.update(phase="submitting", consent=consent)
    save_state(args.state, state)
    client.api(path + "/prepare", {"consent": consent, "terms_version": "testing-risk-v1", "testing_context": ""})
    result = client.api(path + "/review-code", {"code": coupon, "consent": consent})
    if result.get("request_id") != consent["request_id"] or not result.get("review_id"):
        raise ValueError("Checkout has no confirmed review yet. Inspect Audits in the UI; do not submit again")
    state.update(phase="started", review_id=str(uuid.UUID(result["review_id"])))
    save_state(args.state, state)
    print("Audit:", client.origin + "/#/reviews/" + state["review_id"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", default="http://127.0.0.1:7410")
    parser.add_argument("--username", default="local_admin")
    parser.add_argument("--password-file", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True, help="private state file outside the repositories")
    sub = parser.add_subparsers(dest="action", required=True)
    create = sub.add_parser("prepare", help="create a setup; does not start testing")
    create.add_argument("--target", required=True, help="authorized public HTTPS origin")
    create.add_argument("--login-path", help="JSON login path that sets a cookie; omit for black box")
    create.add_argument("--check-path", help="GET path that refuses anonymous access")
    create.add_argument("--username-field", default="username")
    create.add_argument("--password-field", default="password")
    submit = sub.add_parser("start", help="use a coupon to start an ownership-verified setup")
    submit.add_argument("--credentials-file", type=Path, help="private JSON with username/password for the target")
    submit.add_argument("--coupon-file", type=Path, required=True)
    submit.add_argument("--accept-test-risk", action="store_true")
    submit.add_argument("--accept-private-processing", action="store_true")
    args = parser.parse_args()
    client = Client(args.core, args.username, args.password_file)
    (prepare if args.action == "prepare" else start)(client, args)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, KeyError, TypeError, EOFError) as error:
        # Provider/target secrets are never included in diagnostics.
        if isinstance(error, RuntimeError):
            print(str(error))
        raise SystemExit("Stopped. Check the local UI and private state before retrying; checkout may already have succeeded.")
