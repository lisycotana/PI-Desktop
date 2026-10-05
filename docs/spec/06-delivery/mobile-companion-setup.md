# Mobile companion setup and use

This fork now implements the full task workflow, with voice deferred. It is a
request-worktree build, not an installed upstream release. The phone uses the
website first: it connects to the existing desktop AgentHost and uses the
computer's projects/providers. There is no native mobile app or APK.

## Windows personal use

1. Log Tailscale into the same account on the phone and computer, then connect
   both devices to the same tailnet. The private
   HTTPS DNS name is `https://xiaoxinpro16.tail09cc39.ts.net`; it is a tailnet
   name, not a public Funnel address. The backend remains bound to
   `127.0.0.1:4818`, and no router port is opened. Tailscale is required for
   phone access. DNS does not make the machine's IP invisible to other permitted
   tailnet peers, and certificate/DNS metadata can still reveal the hostname.
   Follow the current
   [HTTPS prerequisites](https://tailscale.com/docs/how-to/set-up-https-certificates).
2. Close the installed PI Desktop before launching this fork, so its single
   instance guard does not route into a process without the mobile environment.
3. Build the fork or use its locally produced Windows unpacked application:

```powershell
# In apps/desktop. The explicit run is required: pnpm pack is a package-manager command.
pnpm exec electron-builder --dir --config.directories.output=release/native-chat --config.electronVersion=43.6.0
$env:PI_DESKTOP_MOBILE_ORIGIN = 'https://xiaoxinpro16.tail09cc39.ts.net'
$env:PI_DESKTOP_MOBILE_PORT = '4818'
& '.\apps\desktop\release\native-chat\win-unpacked\PI-Desktop.exe'
```

The earlier `pnpm --filter @pi-desktop/desktop run pack` build lands in
`.\apps\desktop\release\win-unpacked`; the 2026-10-05 final package is the
`native-chat` output above and is the one used for the current checks.

4. In another terminal inspect `tailscale serve status` before changing the
   machine service. If no other service occupies it, run:

```powershell
tailscale serve --bg http://127.0.0.1:4818
```

   Follow [Serve CLI documentation](https://tailscale.com/docs/reference/tailscale-cli/serve).
   Use tailnet Serve. The application does not configure Funnel or edit Serve.
5. Open “Pair a phone” from the desktop tray menu. The native window shows the
   exact HTTPS origin root as a QR URL with a fragment containing a short,
   one-use token and its ISO expiry. It provides Copy code and Copy link
   actions; token visibility is hidden by default and resets when the code is
   renewed. Scan the desktop QR with the phone's camera or system QR reader and
   open the detected URL; the page starts pairing automatically. The website's
   Scan action is also available. Opening a copied link in the same tab also
   starts pairing automatically. The page clears the fragment with
   `history.replaceState` before its first fetch, and session restore waits
   behind this pairing path. Manual code entry is secondary and retains its eye
   visibility toggle. The bundled same-origin `jsQR` scanner is the primary
   scanner across browsers. The token is valid for two minutes. Compare
   the displayed six-digit value on both devices and approve the trusted desktop
   request before the phone receives its HttpOnly session cookie. The request
   has its own full two-minute window from submission. Cancel discards the
   pending request and revokes a session completed concurrently. If the code
   expires or was used, select “New QR code” in the desktop pairing window;
   restarting the app is unnecessary. Add the page
   to the home screen through the phone browser's menu if a PWA shortcut is
   useful; this is optional.

For an isolated Android emulator only, `http://127.0.0.1:<same-port>` with an
ADB reverse is supported. Other LAN HTTP origins are rejected. Production
phone access remains exact HTTPS through Tailscale Serve.

The HttpOnly browser cookie lasts thirty days. The first trusted approval stores
an atomic credential-hash-only authorization record, so a desktop restart keeps
the paired browser and does not force re-pairing. "Connected browsers" can revoke
one browser by id; revocation closes its SSE streams and rejects future requests
but does not stop work already accepted by the desktop. The phone receives
no API key and does not create a custom WebCrypto device key. The desktop must
stay running and reachable for new work; an already started task runs on the
computer while the phone is backgrounded.

## Task workflow

Choose an existing session or create one from the registered project/model list.
Select the supported thinking level, attach files with the plus/attachment button,
and send. Follow-up messages enter the existing queue while a turn runs. Stop and
Interrupt target the displayed active turn; queued messages can be prioritized or
canceled. Models can be changed while idle. Session menu provides rename, fork,
compact and confirmed delete.

Approval and question cards use the Host's actual allowed decisions/options.
Desktop and phone resolve one request once; a later answer reports its resolved
result. Opening the tool row shows complete arguments/results; its more menu and export
retain all returned metadata. Thinking shows only provider-returned content.

Changes lists all working-tree files with pagination. Full patch reads/downloads
the complete per-file patch. Preview hunk limits are explicit. Historical
attachments can be viewed/downloaded from their exact durable message. Workspace
files remain scoped to the registered session root. Git working-tree diff and
persisted tool review evidence have different lifetimes after a commit.

An uncertain send keeps the draft and idempotency key; retry explicitly. Returning
from the background/reconnecting refreshes authoritative state and resumes events.
Refreshing the page restores conversation history, but unsent drafts are memory
only and will not survive a page reload. No offline commands replay automatically.

## Isolated preview

```powershell
node apps/desktop/test/helpers/mobile-preview.mjs
```

Open the printed loopback URL and pair using the private setup file. This fixture
uses no real provider/profile/database. Send a sample prompt, type `request` in
its terminal to emit approval/input cards and `demo` to finish a sample turn.
Type `close` to stop. It supports browser QA but proves no phone connectivity.

## Disable and validation limits

Remove `PI_DESKTOP_MOBILE_ORIGIN` and restart the fork. Manage any separate Serve entry
through its documented CLI. Real phone installation, cellular transitions and
actual-provider execution remain separate validation gates. There is no
installed mobile app. MuMu is stopped; installation is not required for this
website-first path. The current rebuild has passed the focused code and browser
checks recorded in the readiness document. The final Windows unpacked build was
packaged and launched against the existing profile. Both native copy actions
were checked against the actual system clipboard. An authenticated full real
workflow and physical phone access remain unverified. Live voice is explicitly deferred.
