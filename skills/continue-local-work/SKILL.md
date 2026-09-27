---
name: continue-local-work
description: Continue a local software, data, or model-training project through Chatwork Bridge using workspace inspection, guarded file edits, verified commands, recoverable jobs, read-only Git inspection, and native macOS UI actions.
---

# Continue Local Work

Use Chatwork Bridge as a local execution layer, not merely as a source of code suggestions. It exposes 32 MCP tools in version 0.4.4.

## Working loop

1. Start or resume project work with `workspace_snapshot`. It combines project markers and instructions, a bounded directory view, read-only Git state, write eligibility, and related jobs. `workspace_snapshot` is read-only, but seeing only that schema (or other inspection schemas) is never sufficient evidence that the Bridge is read-only. If the user requested edits, commands, or training, explicitly discover/load `apply_patch`/`write_file`, `run_command`, `start_job`, or `capability_catalog` before claiming those abilities are unavailable. Use `bridge_info` for configured boundaries, the explicit access profile, and the server-side tool-surface digest; use `bridge_diagnostics` after a timeout, 404, or reconnect. `capability_catalog` reports the complete server inventory. The server cannot observe or force the smaller subset a client may cache or select for one conversation; if rediscovery still shows a stale client list, retest after refreshing/reinstalling the plugin and starting a new conversation.
2. Inspect before changing anything. Prefer `read_files` for a small related batch and `read_file` when a revision hash will guard a later edit. Respect per-file failures and preserve unrelated user work.
3. Use the narrowest mutation: `replace_text` for one exact replacement, `apply_patch` for focused multi-file code edits, and `write_file` for a complete small file. Pass revision hashes when files may change concurrently.
4. Prefer `git_status`, `git_diff`, and `git_log` for repository inspection. They are fixed, read-only tools. Use `run_command` only when a dedicated tool does not fit and the command will finish within its reported maximum. Use `start_job` for training, downloads, builds, benchmarks, or anything that may outlive one tool call; never request a longer synchronous timeout because an expired tunnel response can break the channel.
5. Before a destructive, external, costly, cancellation, installation, permission, or visible desktop action, identify the exact target and honor the client's confirmation step.
6. Verify observable results by rereading files, running focused checks, inspecting job status and logs, or taking a fresh screenshot. Continue while a safe in-scope next step remains, then report the outcome, relevant paths or job IDs, and any remaining uncertainty.

## Boundaries

- Read tools and write/command tools use separate configured roots. A broad read root does not expand write access.
- When `bridge_info.accessProfile.fullFilesystemRead` is true, full-machine reading is deliberate for the Chat runtime. Narrow it by changing `CHATWORK_READ_ROOTS` and restarting; never assume it follows the write roots.
- Dedicated file tools and the default macOS command sandbox reject Bridge internals, credential stores, Keychains, browser profiles, and selected credential files. Never relax that boundary merely to inspect a secret, and never expose secrets from files, environment variables, output, or audit logs.
- On ordinary macOS hosts, commands report whether the project-scoped process sandbox was applied. Treat `sandboxed: false` and its warning as a real reduction in containment; do not claim that cwd validation alone prevents an absolute-path command from accessing other user-readable locations.
- Risk annotations may cause ChatGPT to ask for confirmation; they do not mean a tool is absent.

This skill approximates a Work-style local workflow using the tools the MCP server actually exposes. It cannot add ChatGPT's native browser semantics, web search, connectors, product orchestration, scheduled Automations, background conversation wake-ups, or hidden Work tools. A persistent local job continues independently but cannot proactively send a new Chat message. The bridge also cannot change or bypass Chat, Work, Codex, API, or tunnel usage limits.

## Long-running work and model training

Read [model-training.md](references/model-training.md) when a task starts, resumes, diagnoses, cancels, or monitors model training or another expensive/long job.

## Desktop operation

Read [computer-control.md](references/computer-control.md) before the first semantic element press, screenshot-dependent coordinate action, keyboard action, app launch, or URL opening in a task.
