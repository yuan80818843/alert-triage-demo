#!/usr/bin/env python3
"""Thin, read-only gRPC caller. No embedded rules, data, or expected labels."""
import json
import os
import re
import subprocess
import sys


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", sys.argv[1]):
        raise ValueError("One valid alert ID is required")
    run_id = os.environ.get("AGENT_COMPOSE_RUN_ID", "")
    if not re.fullmatch(r"[a-f0-9]{64}", run_id):
        raise RuntimeError("Platform run ID is unavailable; do not invent one")
    result = {"run_context": {"run_id": run_id}}
    for method in ("GetAlertDetail", "QueryEvidence", "SearchSimilarCases"):
        command = [
            "grpcurl", "-plaintext", "-connect-timeout", "3", "-max-time", "15",
            "-H", "x-capability-sandbox-token: " + os.environ["CAP_TOKEN"],
            "-H", "x-octobus-capset: triage-read",
            "-H", "x-octobus-instance: alert-platform-demo",
            "-d", json.dumps({"alertId": sys.argv[1]}), os.environ["CAP_GRPC_TARGET"],
            "alert_triage.v1.AlertPlatformService/" + method,
        ]
        response = subprocess.run(command, capture_output=True, text=True, timeout=20)
        if response.returncode:
            raise RuntimeError(method + " failed; no conclusion is authorized")
        result[method] = json.loads(response.stdout)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, KeyError, OSError, subprocess.TimeoutExpired):
        print("Read capability failed; keep the alert for human review.", file=sys.stderr)
        sys.exit(1)
