#!/usr/bin/env python3
"""Read-only isolation probes; print presence of runtime tokens, never values."""
import json
import os
from pathlib import Path
import socket
import urllib.error
import urllib.request


def reachable(host, port):
    try:
        with socket.create_connection((host, port), timeout=2):
            return True
    except OSError:
        return False


results = []
for label, host, port, expected in [
    ("capability-proxy", "agent-compose", 7411, True),
    ("direct-octobus", "octobus", 9000, False),
    ("direct-mock-host", "172.17.0.1", 8081, False),
    ("direct-public-internet", "1.1.1.1", 443, False),
    ("cloud-metadata-aliyun", "100.100.100.200", 80, False),
    ("cloud-metadata-linklocal", "169.254.169.254", 80, False),
]:
    actual = reachable(host, port)
    results.append({"check": label, "passed": actual == expected, "reachable": actual})

# The daemon is intentionally reachable for its scoped runtime LLM facade,
# but an unauthenticated caller must not be able to administer it.
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
request = urllib.request.Request(
    "http://agent-compose:7410/agentcompose.v2.LLMService/ListProviders",
    data=b"{}", headers={"Content-Type": "application/json"}, method="POST",
)
try:
    with opener.open(request, timeout=3) as response:
        status = response.status
except urllib.error.HTTPError as error:
    status = error.code
except OSError:
    status = 0
results.append({"check": "control-plane-requires-auth", "passed": status in (401, 403), "http": status})
for name in ("CAP_TOKEN", "CAP_GRPC_TARGET"):
    results.append({"check": name + "-present", "passed": bool(os.environ.get(name))})
for name in ("AGENT_COMPOSE_AUTH_TOKEN", "OCTOBUS_ADMIN_TOKEN"):
    results.append({"check": name + "-absent", "passed": not bool(os.environ.get(name))})
results.append({"check": "schema-in-workspace", "passed": Path("output-schema.json").is_file()})
print(json.dumps({"checks": results, "passed": all(item["passed"] for item in results)}, indent=2))
raise SystemExit(0 if all(item["passed"] for item in results) else 1)
