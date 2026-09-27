# Model training and long jobs

Use this reference for training, data preparation, builds, development servers, and other work that may survive one MCP call or conversation reconnect.

## Inspect and launch

Start with `workspace_snapshot` to inspect repository instructions, configuration, dataset references, checkpoints, Git state, and related existing jobs. Call `runtime_info` with the project path and use the reported absolute interpreter. Prefer Apple MPS only when its real tensor probe succeeds; set `PYTORCH_ENABLE_MPS_FALLBACK=1` only for a demonstrated unsupported operation.

Treat resource fields carefully. `disk.lowSpaceForTraining` uses a 30 GiB caution threshold and should trigger a bounded plan for datasets, caches, logs, and checkpoints. On macOS, `host.freeMemoryBytes` is only the immediately unused page count; prefer `memory.pressureFreePercent`, Activity Monitor memory pressure, and a small representative batch before deciding that a larger run fits.

Before launch, surface the exact argv, working directory, expected artifacts, checkpoint/resume behavior, approximate compute and storage needs, and any network or paid-service cost. Keep outputs and checkpoints under a configured write root. Prefer the project's existing entrypoint over inventing a new training stack.

Use `run_command` only for bounded probes and short checks. It is hard-capped at 90 seconds so its response remains below the Secure MCP Tunnel deadline; asking for a larger timeout is invalid. Its structured result separates stdout and stderr and reports status, timeout, duration, truncation, and whether the macOS process sandbox was active. Use `start_job` for training, downloads, builds, benchmarks, or anything likely to outlive a call, and retain its `jobId`.

## Monitor and recover

After launch, inspect both `job_status` and `job_tail`. Use `wait_job` with the latest status and log byte count to wait efficiently for progress or completion instead of rapid polling. Do not declare success because a process merely started. Look for loss movement, throughput, validation metrics, checkpoints, NaNs, data-loading errors, out-of-memory failures, and final artifacts.

The job supervisor persists metadata and the real command result independently of the MCP connection. After a Chat/tunnel/Bridge reconnect, call `list_jobs` and match by label, cwd, and start time; then continue with the recovered `jobId`. Terminal states can include `succeeded`, `failed`, `cancelled`, `spawn-failed`, and `finished-unknown` for a legacy or externally lost process. Use exit code, signal, timestamps, and artifacts as evidence.

Logs are bounded and rotated. `job_tail` reads only the latest requested lines and reports truncation, so preserve important metrics or checkpoints in project artifacts rather than treating the log as permanent unlimited storage. The configured concurrent-job limit defaults to eight; reaching it is a reason to inspect existing jobs, not to launch unmanaged duplicates.

## Timeout, cancellation, and containment

Short-command timeout and `cancel_job` terminate the managed process group, escalating after a grace period when necessary. Do not cancel, restart, delete checkpoints, or change a paid remote run without the user's confirmation. When diagnosing a failure, preserve logs and artifacts, make one testable correction, and relaunch only after verifying that correction.

On macOS, inspect the returned `sandboxed` field. When enabled, writes are limited to configured project roots, task state/cache, temporary storage, and necessary development caches; common credentials and Bridge internals are denied reads by default. The sandbox does not block network access. If containment is required and the field is false, stop instead of assuming cwd is a security boundary; the ChatGPT runtime enables fail-closed behavior with `CHATWORK_REQUIRE_PROCESS_SANDBOX=1`.

A persistent job is a local process, not a ChatGPT scheduled task. It survives reconnects and can be checked later, but it cannot wake the conversation, schedule a native Automation, or notify the user by itself.
