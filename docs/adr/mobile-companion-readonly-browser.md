# Personal mobile browser control of the desktop AgentHost

Date: 2026-10-04. Status: implemented in the fork request worktree; unreleased.
This decision supersedes the initial read-only slice at this path.

## Context

The owner chose a personal PWA over Tailscale, then required the complete task
workflow with voice deferred. A dedicated ChatGPT web conversation informed the
plan. PI already has AgentHost/RACP and durable Host ports, but no browser entry
into the existing desktop's sessions. Starting pi-host would create a separate
runtime. Ordinary browser WebSockets cannot set the existing WS binding's
Authorization header.

## Decision

Desktop startup/shutdown owns a default-off loopback HTTP listener. It receives
that desktop's exact AgentHost and maps a finite action allowlist through the
existing RACP schemas and handlers. It does not expose generic IPC/Host RPC,
provider credentials, terminals, device administration, or project registration.
Capabilities identify a `controller-subset`, not complete RACP-HTTP conformance.
The original unconfigured read-only adapter remains available for compatibility.

Pairing grants viewer/controller/approver roles with `pairedDevice: false`.
Canonical RACP owner rules stay unchanged. The personal browser transport also
explicitly grants deletion of an idle conversation, through the existing desktop
session-delete IPC cleanup path and a confirmation dialog. This one-operation
policy does not grant owner privileges or device revocation. Browser-created
sessions begin at Ask; browser configuration cannot change stored permission mode.

The execution authority is host-core. `session.beginTurn` optionally admits a
concrete permission ceiling, refuses widening and binds it to the admitted turn.
Both `tools.execute` and `permissions.evaluate` apply the narrower of current
stored/default policy and the turn ceiling. Subagent scopes cannot bypass this
ceiling. It is nonpersistent; exact-turn completion, truncation/deletion and
restart clear it. A stale end cannot clear a newer scope. An Ask queued request
cannot be steered into an already-running, more permissive turn. A real Write
execution test proves no bytes are written before approval, denial writes no file
and approval permits execution without changing the durable Auto session.

Uploads accept bytes and validated metadata, not browser-supplied native paths.
Opaque IDs are tied to one browser/session, bounded by 10 MiB/file, eight upload
slots and 40 MiB outstanding bytes per session. Canonical checks precede directory
creation and reads; size/hash checks reject modifications. Unconsumed uploads
expire after one hour and are cleaned at shutdown. Accepted queue files survive
expiry/restart for desktop attachment preparation. Quotas are released at expiry.
Only a reference in the exact durable message can authorize a later attachment
read, and the real path must remain within its workspace or attachment roots.

The small same-origin UI supplies sessions, models, attachments, streaming chat,
approval/input cards, queue control, stop/interrupt, rich text, returned thinking,
complete raw tool arguments/results and exported evidence. It uses the actual
shared delta reducer. Snapshot generation guards prevent stale results changing
another session; uncertain sends retain their identity for explicit retries.
Cursor replay or authoritative snapshot restores foreground/reconnect state.
No offline command is replayed automatically.

Shared diff previews remain bounded and disclose their limits. A separate scoped,
paginated Git catalog and streamed per-file patch cover the complete working-tree
changes, including rename/binary metadata. A registered subdirectory cannot read
sibling project changes. Working-tree changes are not claimed as a durable
per-turn edit ledger; persisted tool review evidence retains its own meaning.

Production opt-in requires an exact HTTPS origin. The listener binds
127.0.0.1; Tailscale Serve supplies tailnet HTTPS. The isolated emulator path
supports only the exact `http://127.0.0.1:<port>` origin with same-port ADB
reverse. No LAN HTTP is accepted. Setup never enables Funnel. A proxy's
loopback address is not an application identity. API requests require the exact
custom Origin header, reject a conflicting native Origin and unknown Host, and
allow no CORS preflight. All mutations require CSRF. CSP allows same-origin code
and safe image previews without unsafe-eval or unsafe-inline scripts.

Pairing reuses the RACP one-use bootstrap shape: a 192-bit random code is valid
for two minutes, is consumed synchronously, and produces a pending request with
a separate completion secret and six-digit verification code. A trusted native
desktop confirmation approves or rejects the request before the browser can
obtain an eight-hour HttpOnly/Secure/SameSite cookie. The native QR encodes the
exact HTTPS origin root as a URL with a fragment of the form
`#pair=<short-192-bit-one-use-token>&expires=<ISO>`. The fragment is never sent
in the HTTP request. The page parses it synchronously and calls
`history.replaceState` before its first fetch, so a same-tab link can pair
automatically without leaving the token in browser history or later requests.
Manual code input remains available. Native pairing provides local Copy code and
Copy link actions, and an eye toggle for the token is hidden by default and
resets when a code is renewed; the web manual field has the same visibility
behavior. Copy actions are exact local Main-process actions for live, unexpired
pairing data and do not add broad IPC.

The desktop exposes a trusted tray/settings flow (“Pair a phone” and
“Connected browsers”) with per-browser revoke. Revoke closes that browser's SSE
streams and rejects future cookie authentication; it does not stop already
accepted desktop work. Restart invalidates all browser sessions. Windows ACLs,
not file mode alone, protect the user directory. The PWA caches static assets
only, never transcripts, API responses or credentials.

## Alternatives and consequences

A hosted relay/native client would ease background push and onboarding but adds
identity/storage/operations outside personal use. An independent headless Host
loses the existing desktop session identity. Weakening WS credentials is rejected.

Default desktop behavior, persistence schemas and existing IPC contracts remain
compatible. Opt-in adds a listener/setup file and scratch uploads. Removing its
environment variables disables the listener on next launch. Voice, push, terminal
and device administration remain deferred. Isolated HTTP/browser tests and actual
Host permission tests establish their specific boundaries; they do not establish
real-phone, packaging-launch, cellular or real-provider validation.
