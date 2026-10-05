# Mobile companion task workflow

Date: 2026-10-04. Baseline: `0d47d267`. Status: implementation and validation
in the request worktree; not an installed release or a real-phone validation.

## Scope

The owner requires the complete task workflow through a personal browser/PWA
over Tailscale. Voice is explicitly deferred. The phone attaches to the existing
desktop AgentHost: one runtime, authoritative history, queue, approvals and Host
permission evaluation. The ChatGPT mobile benchmark concerns task interaction;
it does not imply access to proprietary services or undisclosed model reasoning.

The dedicated [web planning conversation](https://chatgpt.com/c/6abfabfc-81a8-83ea-9000-0fac4333c746)
was consulted again for this scope change using agent-browser-cli. Its useful
decisions are distilled below. Web advice is not code or validation evidence.

| Workflow | Required observable result |
| --- | --- |
| Sessions | List/search existing desktop sessions; create with a registered project and model; rename/fork/compact/delete with explicit user actions |
| Chat | Send a prompt, keep its identity across an uncertain retry, queue follow-ups, stop/interrupt and cancel/prioritize queued turns |
| Attachments | Upload browser bytes, verify bounded metadata and content, bind an opaque upload ID to one browser/session and pass the trusted result through desktop attachment preparation |
| Models | Choose from the existing desktop's cached provider/model metadata, configure an idle session and expose only supported thinking levels |
| Approvals | Show Host-issued allowed decisions; desktop/phone concurrency resolves once; stale responses expose the actual final result |
| Input | Answer Host-issued single/multiple choice or free text questions and permit skipping where the Host allows it |
| Transcript | Reconstruct text/thinking deltas with the shared reducer, preserve completed history, tool identities, raw arguments/results, errors, usage and attachment references |
| Changes | Page through all changed files; show relative/full paths, rename and binary metadata, preview hunks and read/download a complete single-file patch |
| Recovery | Resume through cursor replay and authoritative snapshot after background, disconnect or refresh; never replay an unsent command automatically |
| Mobile use | Accessible touch controls, safe-area layout, no horizontal overflow at 320px and an installable static PWA shell |

## Information completeness

The UI can collapse content without discarding it. Raw arguments/results and
returned thinking remain inspectable and exportable. A model token count is not
reasoning text. Only `UiMessage.thinking` supplied by the provider/runtime can
be shown. [OpenAI's reasoning documentation](https://developers.openai.com/api/docs/guides/reasoning)
distinguishes returned summaries from inaccessible raw reasoning tokens.

The shared preview has a 100-file list cap and omits hunks for patches over
200 KiB. Those flags must be explicit. A separate paginated catalog and streamed
raw patch supply complete changes beyond those preview limits; transfer failures
are explicit, never a silently successful partial result. Binary metadata is
shown without invented text hunks. The current working-tree diff is not a durable
per-turn edit ledger; persisted `ReviewChange` evidence in tool results keeps its
own meaning after commits.

Implementation reuses the desktop `ToolRow`/tool-display contract, shared
message-stream reducer, and host-runtime workspace review/diff types. Mobile
does not invent a parallel tool or edit ledger.

## Trust and lifecycle

The browser principal has viewer, controller and approver roles, without owner
or paired-device exemptions. The execution boundary applies the narrower of the
stored/default mode and the nonpersistent turn ceiling. A narrowed queued turn
must not be steered into a more permissive running turn. Browser configuration
cannot widen the desktop's stored permission mode.

The listener binds loopback. Production requires exact same-origin HTTPS through
Tailscale Serve, paired HttpOnly/Secure/SameSite cookies, Origin/Host checks and
CSRF on mutations. The isolated emulator exception is only the exact
`http://127.0.0.1:<port>` origin with same-port ADB reverse; LAN HTTP is not
supported. No raw IPC/Host RPC, provider secrets, CORS allowance or URL
credentials are exposed. Static shell caching excludes API responses and private
transcripts. Desktop shutdown/restart closes streams and revokes browser sessions.

Pairing reuses a 192-bit, two-minute, single-use bootstrap code. A pending
request carries a separate completion secret and six-digit verification code;
trusted native desktop approval/rejection is required before the eight-hour
HttpOnly cookie is issued. Native QR is the exact HTTPS origin root with a URL
fragment `#pair=<short-192-bit-one-use-token>&expires=<ISO>`. Fragments are
absent from HTTP requests; the page parses the fragment synchronously and
clears it with `history.replaceState` before its first fetch. A same-tab link
therefore starts automatic pairing and takes precedence over session restore.
Manual input remains supported. Connected browsers are listed and revocable by
id; revoke closes SSE and rejects future cookies but does not stop already
accepted desktop work.

Uploads use browser/session ownership, size/count/aggregate quotas, canonical
containment and server-chosen paths. A browser path is never a trusted filesystem
reference. Accepted queued attachments cannot expire before desktop preparation.
Original desktop attachment storage remains the persistence owner.

## Validation gates

Use real shared AgentHost/RACP semantics and actual HTTP/browser transport, with
fakes only for external providers or an isolated Host boundary. Exercise the
complete sequence from pairing to sending/approval/input/stop/history/changes,
plus retry, concurrent approval, stale async results and reconnect. Prove the
permission ceiling with the actual Rust Host boundary. Run package contract
tests, desktop typecheck/build and focused mobile interaction tests.

Real phone installation, cellular/Wi-Fi transitions and the user's actual model
session require separate evidence. MuMu install/new-package launch is pending.
Do not label isolated fixtures as those passes.
