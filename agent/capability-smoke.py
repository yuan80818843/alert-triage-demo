#!/usr/bin/env python3
"""Exercise the real sandbox -> capproxy -> OctoBus path, without an LLM."""
import json
import os
import subprocess


def invoke(capset, method, request):
    args = [
        "grpcurl", "-plaintext", "-connect-timeout", "3", "-max-time", "15",
        "-H", "x-capability-sandbox-token: " + os.environ["CAP_TOKEN"],
        "-H", "x-octobus-capset: " + capset,
        "-H", "x-octobus-instance: alert-platform-demo",
        "-d", json.dumps(request), os.environ["CAP_GRPC_TARGET"],
        "alert_triage.v1.AlertPlatformService/" + method,
    ]
    result = subprocess.run(args, capture_output=True, text=True, timeout=20)
    if result.returncode == 0:
        return json.loads(result.stdout), "OK"
    # No stderr/body is logged; expose only a recognized gRPC status name.
    code = next((code for code in ("PermissionDenied", "Unauthenticated", "NotFound", "Unimplemented", "Unavailable") if code in result.stderr), "CALL_FAILED")
    return None, code


passed = True
for alert_id in ("ALT-001", "ALT-002", "ALT-003"):
    body, code = invoke("triage-read", "QueryEvidence", {"alertId": alert_id})
    actual = body.get("recommendedClassification") if body else None
    ok = code == "OK" and bool(actual) and bool(body.get("evidence"))
    passed = passed and ok
    print(json.dumps({"check": "sandbox-query", "alert_id": alert_id, "classification": actual, "grpc": code, "passed": ok}))

# The unbound high-privilege capset must be rejected before the empty request
# could reach a business handler. No disposition is ever created by this test.
body, code = invoke("triage-human-write", "CreateDisposition", {})
ok = code == "PermissionDenied"
passed = passed and ok
print(json.dumps({"check": "sandbox-write-capset-denied", "grpc": code, "passed": ok}))
raise SystemExit(0 if passed else 1)
