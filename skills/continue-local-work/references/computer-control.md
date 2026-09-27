# macOS computer control

Computer actions require Screen Recording and Accessibility permission for the process that actually runs the stable Chatwork Bridge runtime. After granting either permission, restart the Bridge or tunnel client before retrying.

## Observe, act, verify

Prefer `computer_inspect_ui`, then call `computer_press_element` with the latest snapshot ID and a pressable element path. Use `computer_active_app` when focus is uncertain. Take `computer_screenshot` immediately before any coordinate-based fallback; perform one focused `computer_action`, then capture another screenshot and verify the visible change.

Native Accessibility snapshots expose bounded roles, labels, values, bounds and actions; sensitive text fields are redacted, and an element press revalidates PID/path/role/title. Available fallback actions are click, type, key press with modifiers, page scroll, app launch, and URL opening. Coordinates become stale when a window moves, content scrolls, a sheet opens, display scaling changes, or focus moves. Do not reuse them without a fresh screenshot.

Prefer project/file/Git tools for deterministic work. Use visible desktop actions only when the target application has no appropriate structured tool or the user specifically needs UI interaction.

## Consequential UI

Treat actions that send, publish, buy, delete, install, grant permission, disclose data, sign in/out, start a paid operation, or submit a form as consequential. State the exact app, control, and effect, then wait for user confirmation immediately before the action. Never type a secret recovered from a path that the Bridge's file tools intentionally refuse.

If a dialog, permission prompt, CAPTCHA, secure-input field, or unexpected page appears, stop and inspect it. Do not infer success from a click alone.

## Product boundary

The native tools expose macOS Accessibility semantics, while `computer_action` controls pixels and keyboard input. Neither exposes browser DOM, network requests, downloads as structured objects, ChatGPT Browser, web search, or another connector. Opening a URL is not evidence that its page loaded or that an action completed; verify visually.

Likewise, UI control does not create native ChatGPT schedules or background follow-ups. A local long-running job and a visible browser session can remain open, but the MCP server cannot wake a future Chat turn or reproduce ChatGPT's product-level orchestration.
# Native mouse controls

Use computer_action with mouse_move, mouse_click, mouse_drag, or mouse_scroll.
Take a fresh computer_screenshot before each action; verify with a new screenshot afterward.
Coordinates are macOS global logical points, not Retina screenshot pixels.
mouse_click supports left/right/middle button, clickCount 1–3 and modifiers.
mouse_drag uses x/y, toX/toY, durationMs 100–3000, button and modifiers.
mouse_scroll targets x/y and uses deltaX/deltaY in pixels (positive right/down).
Do not infer application success from event delivery alone.
