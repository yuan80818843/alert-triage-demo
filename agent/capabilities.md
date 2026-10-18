# Supported read-only interface

Use the read-only helper with a login shell, so the platform supplies its
run-scoped credential without printing it:

    bash -lc 'python3 /workspace/read-alert.py ALT-001'

Replace the alert ID with the current task alert. The helper calls only
GetAlertDetail, QueryEvidence and SearchSimilarCases through capproxy/gRPC.
It prints their actual JSON responses. It does not contain expected answers.
Copy report.run_id exactly from the helper's run_context.run_id, which is
injected by the platform. Never invent a run identifier.

For polling, ListAlerts may be called with grpcurl using the same metadata.
The target is $CAP_GRPC_TARGET, metadata is x-capability-sandbox-token:
$CAP_TOKEN, x-octobus-capset: triage-read, x-octobus-instance:
alert-platform-demo. Use the runtime capability catalog for reflection.

Never run env, printenv, set, shell tracing, or print/read credential files.
Never print tokens or put them in reports. Do not run diagnostic smoke tests
as evidence or infer labels from test fixtures. Only current OctoBus tool
responses are business evidence.
