"""Offline helper checks: no providers, live targets, checkout or real credentials."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location("local_audit", Path(__file__).with_name("local-audit.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
NEAR, VENICE = helper.MODELS


class FakeClient:
    origin = "http://127.0.0.1:7410"

    def __init__(self):
        self.calls = []
        self.target = {"id": str(uuid.uuid4()), "scope_sha256": "a" * 64,
                       "scope": {"origins": ["https://owned.example"], "authentication": "session"},
                       "state": "approved", "ownership_verified": True, "can_start": True}
        self.plan = {"scope_sha256": "a" * 64, "recommended_device_ids": ["one", "two"],
                     "recommended_worker_pool": True, "recommended_review_policy": "investigate_validate_v1",
                     "fallback_model": VENICE, "candidates": [
                         {"device_id": name, "operator_id": "local", "declared_model": NEAR} for name in ["one", "two"]]}
        self.uncertain = False

    def api(self, path, body=None):
        self.calls.append((path, body))
        if path == "/pentests" and body is None:
            return [self.target]
        if path.endswith("review-plan"):
            return self.plan
        if path.endswith("review-code"):
            if self.uncertain:
                raise OSError("simulated lost response after checkout")
            return {"request_id": body["consent"]["request_id"], "review_id": str(uuid.uuid4())}
        return self.target


class LocalAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.client = FakeClient()
        self.args = SimpleNamespace(state=root / "state.json", coupon_file=root / "coupon.txt",
                                    credentials_file=None, accept_test_risk=True, accept_private_processing=True)
        self.args.coupon_file.write_text("pr-" + "0" * 64)
        self.args.coupon_file.chmod(0o600)
        helper.save_state(self.args.state, {"core": self.client.origin, "phase": "prepared",
                                           "pentest_id": self.client.target["id"], "scope_sha256": "a" * 64}, new=True)
        output = contextlib.redirect_stdout(io.StringIO())
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)

    def start(self, answer="START"):
        with patch("builtins.input", return_value=answer):
            helper.start(self.client, self.args)

    def no_checkout(self):
        self.assertFalse(any(path.endswith(("/prepare", "/review-code")) for path, _ in self.client.calls))

    def test_requires_ownership_before_credentials_or_checkout(self):
        self.client.target["ownership_verified"] = False
        with self.assertRaises(ValueError):
            self.start()
        self.assertTrue(all(body is None for _, body in self.client.calls))
        self.no_checkout()

    def test_changed_scope_stops_before_checkout(self):
        self.client.target["scope_sha256"] = "b" * 64
        with self.assertRaises(ValueError):
            self.start()
        self.no_checkout()

    def test_unknown_provider_cannot_receive_consent(self):
        self.client.plan["candidates"][0]["declared_model"] = "unrecognized"
        with self.assertRaises(ValueError):
            self.start()
        self.no_checkout()

    def test_private_processing_and_test_risk_are_explicit(self):
        for flag in ("accept_test_risk", "accept_private_processing"):
            setattr(self.args, flag, False)
            with self.assertRaises(ValueError):
                self.start()
            setattr(self.args, flag, True)
        self.no_checkout()

    def test_declining_final_confirmation_does_not_spend(self):
        self.start("no")
        self.no_checkout()
        self.assertEqual(json.loads(self.args.state.read_text())["phase"], "prepared")

    def test_pool_scope_and_backup_consent_match_both_api_calls(self):
        self.start()
        posts = [(p, b) for p, b in self.client.calls if b is not None]
        self.assertTrue(posts[0][0].endswith("/prepare"))
        self.assertTrue(posts[1][0].endswith("/review-code"))
        self.assertEqual(posts[0][1]["consent"], posts[1][1]["consent"])
        self.assertEqual(posts[0][1]["consent"]["fallback_model"], VENICE)
        self.assertTrue(posts[0][1]["consent"]["use_worker_pool"])
        self.assertEqual(json.loads(self.args.state.read_text())["phase"], "started")
        self.assertNotIn("pr-", self.args.state.read_text())

    def test_uncertain_checkout_is_not_retried(self):
        self.client.uncertain = True
        with self.assertRaises(OSError):
            self.start()
        self.assertEqual(json.loads(self.args.state.read_text())["phase"], "submitting")
        count = len(self.client.calls)
        with self.assertRaises(ValueError):
            self.start()
        self.assertEqual(len(self.client.calls), count)

    def test_private_files_reject_world_readable_or_symlink(self):
        self.args.coupon_file.chmod(0o644)
        with self.assertRaises(ValueError):
            helper.private_text(self.args.coupon_file)
        self.args.coupon_file.chmod(0o600)
        link = self.args.coupon_file.with_name("linked.txt")
        link.symlink_to(self.args.coupon_file)
        with self.assertRaises(OSError):
            helper.private_text(link)

    def test_password_not_read_for_nonlocal_origin(self):
        for origin in ["https://example.com", "http://127.0.0.1:7410/path", "http://127.0.0.1:7410?x=1"]:
            with self.assertRaises(ValueError):
                helper.Client(origin, "local", Path("does-not-exist"))

    def test_redirect_is_not_followed_with_private_request_data(self):
        self.assertIsNone(helper.NoRedirects().redirect_request(None, None, 307, "", {}, "https://outside.example"))


if __name__ == "__main__":
    unittest.main()
