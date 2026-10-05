# Mobile companion readiness

Date: 2026-10-05 (initial 2026-10-04). Baseline: `c1afefea7bb8156a32e7c083feae86c130cc7c0d`
(upstream main after v0.16.1; the earlier baseline was
`0d47d26769ecbeca1c3ab56fa83b58a91de8190e`).
Fork `lisycotana/PI-Desktop` main was synchronized without force to upstream.
Implementation is in `codex/mobile-companion`, `F:\develop\PI-Desktop-mobile`.
Changes are uncommitted. The installed profile was inspected for the authorized
check, so this is not an installed-profile-untouched claim.

The installed older PI instance was stopped normally for the authorized profile
check and then restored to its tray state. The original SQLite backup at
`C:\Users\REISEN\.pi-desktop\backups\mobile-pre-upgrade-2026-10-04\pi.sqlite`
reported `quick_check` as ok. MuMu is stopped and no mobile APK is installed;
the latest Windows unpacked package launch was verified separately.

## Decision and research

The owner selected a personal website over Tailscale and requires the complete
task workflow; voice follows later. A home-screen PWA shortcut is optional;
there is no native mobile app or APK. Dedicated
[ChatGPT web planning](https://chatgpt.com/c/6abfabfc-81a8-83ea-9000-0fac4333c746)
was consulted through agent-browser-cli, including the full-workflow revision.
The resulting [acceptance matrix](mobile-companion-task-workflow.md),
[ADR](../../adr/mobile-companion-readonly-browser.md) and
[setup guide](mobile-companion-setup.md) describe the implementation and limits.

| Reference | Borrowed pattern | Local decision |
| --- | --- | --- |
| [Happy](https://github.com/slopus/happy/blob/main/docs/protocol.md) | Local runtime with mobile synchronization | No additional hosted relay/storage for personal use |
| [HAPI](https://github.com/tiann/hapi/blob/main/docs/guide/how-it-works.md) | User-owned Hub, browser REST/SSE | Reuse the existing desktop Host rather than create another Pi session |
| [OpenCode](https://dev.opencode.ai/docs/server/) | Host-owned sessions and event clients | Reuse PI AgentHost/RACP semantics |
| [Claude Remote Control](https://code.claude.com/docs/en/remote-control) | Continue local execution on the phone | Existing desktop stays the execution owner |
| [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) | Same-tailnet private HTTPS DNS entry to `127.0.0.1:4818` | No Funnel, router port or exposed public IP; pairing/Origin/CSRF remain app responsibilities |

## Implemented boundaries

The default-off desktop listener owns startup/shutdown and receives the exact
AgentHost. It implements a controller subset through canonical handlers, plus
scoped uploads, model metadata, attachment reads and complete changes. The UI has
sessions, attachments, chat/queue/stop, approvals/input, rich text, returned
thinking, full raw tool records and reconnect. It never persists transcripts or
credentials in the static PWA cache.

Rust Host admission rejects permission widening. Its actual tool execution and
query paths apply the current policy and per-turn ceiling. Queue steering cannot
merge a narrow request into a permissive running turn. Pairing grants no owner
or paired-device exemption. Conversation deletion is an explicit one-operation
personal browser transport grant; canonical RACP owner rules remain unchanged.

Pairing uses a two-minute one-use QR URL: the exact HTTPS origin root plus
`#pair=<short-192-bit-one-use-token>&expires=<ISO>`. The fragment is absent from
HTTP requests. The page parses it synchronously and clears it with
`history.replaceState` before the first fetch; a same-tab link starts automatic
pairing before session restore. Manual code input remains available, with an
eye toggle. Native pairing provides exact local Copy code and Copy link actions;
token visibility is hidden by default and resets on renewal. Matching six-digit
comparison and trusted desktop approval remain required. Pending requests get a
separate full two minutes from submission. Cancel aborts native confirmation and
revokes a concurrently completed cookie. The native window regenerates codes
through its exact local action without restarting the application. The resulting
session is an eight-hour HttpOnly cookie. The phone receives no API key and
creates no custom WebCrypto device key. Connected browsers revoke per-browser
SSE/future requests; work already accepted by the desktop continues.

Source reuse record: transcript tool presentation follows the desktop
`ToolRow`/`tool-display` semantics; streamed text and returned thinking use the
shared message delta reducer; workspace review uses the shared `WorkspaceDiff`,
`ReviewChange` and host-runtime diff parser rather than a second edit ledger.
The website imports the renderer's actual `tokens.css` and `icons.tsx`;
React renders those SVG icons in the server build, with no browser React bundle.
The phone sidebar preserves the open session, model selection groups/searches
providers, and tools/review preserve complete records behind compact rows.

## Validation record

- Actual Rust Host tests cover admission/widening, policy changes, stale completion,
  cleanup and real Write execution including an attempted Auto subagent scope.
  Denial leaves no file, approval writes the exact bytes, restart retains no scope.
- HTTP workflow tests run the real desktop bridge, shared AgentHost and RACP
  dispatch. Only external Host/provider/runtime boundaries are fixtures. They
  cover session/model operations, opaque attachments, idempotent send, competing
  desktop/phone approval, questions, queue controls, stop/interrupt, history,
  durable attachment ownership, complete changes and logout.
- Filesystem tests cover over 100 changed files, over 200 KiB patches, subdirectory
  isolation, binary metadata, literal paths, junction rejection, upload quotas,
  expiry, integrity and shutdown cleanup.
- The actual served browser script runs interaction tests with only the DOM/fetch
  boundary replaced: shared delta/reset behavior, full tool JSON, safe rich text,
  uncertain retries, stale sends/snapshots, model/upload and approval/input cards.
- AgentHost: 58 passed. RACP: 21 passed. HostRuntime: 115 passed, 3 skipped,
  1 unrelated Windows path assertion failure (`launch-resolver.test.ts`).
- The old full Rust failure report is not a proven baseline: the baseline archive
  attempt failed. Unrelated unchanged areas remain outside this mobile gate;
  baseline execution is not claimed.

Mobile/bridge tests: 102/102 passed, including the final native-composer reuse cases. After native UI inspection found a repeated
top-level JavaScript declaration on QR renewal, the window scripts were scoped
and the persistent-context native test reran 12/12. Expired QR elements obey
the hidden attribute. Desktop typecheck and Electron Vite build passed again.
Focused native UI inspection verified a visible QR and successful regeneration
in the same window. The final Windows unpacked build was packaged and launched.
Native Copy code matched the current one-use token in the system clipboard;
Copy link matched the exact origin, root path, empty query, token and expiry.
Actual Edge checks verified automatic link pairing with the fragment removed
and an eye toggle that preserved the code value at a 390x844 viewport.
AgentHost delete coverage passed its 62/62 and 32/32 targeted suites. Upload ingress coverage passed its
per-browser/global four-request limits, bounded body reads and five-minute
upload gate; both slow-upload cases passed. Packaging and launch are different
gates.

## Final round (2026-10-05)

The separately written mobile composer was replaced by the desktop renderer's
own components: the imported `tokens.css` and `icons.tsx`, the shared message
delta reducer, `ToolRow` summary semantics with complete arguments/results
behind each row, the shared question-answer state, the original single-button
send/stop state machine and the original approval decisions (deny, allow once,
allow this conversation). Session rename, fork, compact, confirmed delete,
edit/resend and branch-from-reply follow the desktop history revision flow.
Model and thinking selection stay in the composer chip with searchable provider
groups and remaining-context readout; task checklist, tool grouping and
sub-agent views reuse the desktop presentation.

Trusted-browser persistence replaced the one-shot browser grant: the first
trusted approval records an atomic credential-hash-only authorization
(`MOBILE_SESSION_LIFETIME`, thirty days) that hydrates after a desktop restart,
so the phone does not re-pair each day. Per-browser revocation from
"Connected browsers" still closes SSE and rejects later requests, and accepted
desktop work continues. A granted browser may also use allow-this-conversation
task control; canonical RACP owner rules and the per-turn permission ceiling
are unchanged, so widening requests are still rejected.

The final unpacked Windows build was packaged and signed to
`apps/desktop/release/native-chat/win-unpacked`. The previously running
`release/win-unpacked` instance still owned port 4818 when the session ended,
so this newest package was not yet the process serving
`https://xiaoxinpro16.tail09cc39.ts.net`. Post-packaging Edge checks confirmed
the model popover, the permission-mode menu, tool activity rows and a 320x430
short viewport with no overflow; these are browser viewport checks, not real

Rebase onto upstream main (2026-10-05): this branch was rebased from `0d47d267`
onto `c1afefea`; `04-e2e-test-plan.md` was the only conflicting file, and both
sides' content was kept. The 102 mobile/bridge tests and the desktop typecheck
were rerun on the new baseline after rebuilding the workspace packages, and both
pass; `pnpm run build:mobile` also completes. `electron-vite build` (the
main/SSR bundle) fails on **pristine upstream main** with
`chunks/node-!~{001}~.js:17:16: ERROR: Unexpected "*"` from
`[vite:esbuild-transpile]`, reproduced with none of this branch's changes
applied, so it is an upstream build regression rather than a companion defect.
Because of it, packaging and the packaged-launch gate were not rerun after the
rebase, and the packaged artifact remains the pre-rebase
`release/native-chat` build.
phone IME validation. An authenticated full real workflow on a real phone
remains unverified.

The bundled same-origin `jsQR` scanner is primary across browsers; the real QR
round-trip decode test passed. Actual camera and iOS capture remain unverified.
Consumed native QR data is cleared when pairing begins, and reject/reopen with a
new token passed. Edge/TMWD browser inspection at 390x844 found no overflow and
a 102px composer; the settled 320x430 short viewport had no overflow and the
composer ended at 426px. These are browser viewport checks, not actual phone IME
validation.

The latest backup at
`C:\Users\REISEN\.pi-desktop\backups\mobile-final-2026-10-04-174618\pi.sqlite`
reported `quick_check` as ok. Final package/launch verification passed. The
listener was verified on `127.0.0.1:4818`,
and `https://xiaoxinpro16.tail09cc39.ts.net` opened with `secureContext=true`.
The earlier real-browser request was cancelled. A fresh HTTPS request displayed
its six-digit comparison and countdown, then expired without manual approval and
showed the localized timeout state. Pair from the tray again when ready;
an authenticated full real workflow is not claimed. MuMu is stopped and no mobile
app is installed. Real phone/PWA installation, cellular transitions and
real-provider sessions remain unverified. The owner reported that phone Tailscale
was disconnected or signed into a different account; the private DNS error has
not been retested after connecting it to the computer's tailnet.
No production profile or provider is
a fixture.
This is a locally reviewable implementation, not a production release claim.
