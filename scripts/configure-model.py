#!/usr/bin/env python3
"""Local administrator helper: a real provider key never enters shell arguments.

Uses the public LLMService RPC of official agent-compose sha-70bfd0b.
No third-party Python packages, no key files, no response-body logging.
"""
import argparse
import getpass
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
import warnings


class SetupError(Exception):
    pass


def read_admin_token():
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if os.name == "posix" and env_file.stat().st_mode & 0o077:
        raise SetupError("Run chmod 600 .env before configuring the model.")
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if line.startswith("AGENT_COMPOSE_AUTH_TOKEN="):
            token = line.partition("=")[2].strip()
            if token:
                return token
    raise SetupError("AGENT_COMPOSE_AUTH_TOKEN is missing from local .env.")


def rpc(method, payload, token):
    request = urllib.request.Request(
        "http://127.0.0.1:7410/agentcompose.v2.LLMService/" + method,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # Never print the body: it may contain provider/upstream diagnostics.
        raise SetupError("Model configuration RPC %s failed: HTTP %s." % (method, error.code)) from None
    except (OSError, ValueError):
        raise SetupError("Model configuration RPC %s failed; check daemon status." % method) from None


def configure(args):
    if not sys.stdin.isatty():
        raise SetupError("Use an interactive SSH terminal; piping a key is not allowed.")
    endpoint = urllib.parse.urlsplit(args.base_url)
    if endpoint.scheme != "https" or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        raise SetupError("The upstream base URL must be HTTPS, without credentials/query/fragment.")
    token = read_admin_token()
    # Determine create/update before prompting for a real credential.
    result = rpc("ListProviders", {"limit": 100}, token)
    exists = any(item.get("id") == "triage-deepseek" for item in result.get("providers", []))
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            key = getpass.getpass("DeepSeek API Key (hidden; not saved in .env): ").strip()
        except getpass.GetPassWarning:
            raise SetupError("A secure terminal is unavailable; key input was refused.") from None
    if not key or any(char.isspace() for char in key):
        raise SetupError("The API Key must be nonempty and contain no whitespace.")
    provider = {
        "id": "triage-deepseek", "name": "Alert Triage DeepSeek",
        "baseUrl": args.base_url.rstrip("/"), "protocol": args.protocol,
        "apiKey": key, "enabled": True,
        "models": {"models": [{"id": "deepseek-v4-flash", "maxOutputTokens": 8192}]},
    }
    rpc("UpdateProvider" if exists else "CreateProvider", {"provider": provider}, token)
    provider.pop("apiKey", None)
    del key
    rpc("SetDefaultModel", {"model": {"providerId": "triage-deepseek", "modelId": "deepseek-v4-flash"}}, token)
    public = rpc("GetProvider", {"id": "triage-deepseek"}, token).get("provider", {})
    if not public.get("apiKeySet") or not public.get("enabled"):
        raise SetupError("The daemon did not confirm an enabled provider with a credential.")
    print("Provider saved in daemon storage; API Key was not printed or passed to the guest.")
    print("Model: deepseek-v4-flash; protocol: " + args.protocol)
    print("Scheduler is still paused. This is configuration, not a successful end-to-end model test.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="https://api.deepseek.com")
    parser.add_argument("--protocol", choices=["responses", "chat_completions"], default="responses")
    try:
        configure(parser.parse_args())
    except (SetupError, OSError) as error:
        print(str(error) if isinstance(error, SetupError) else "Cannot read local configuration; check file permissions.", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("Configuration cancelled; no key was printed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
