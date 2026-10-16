# Akatsuki collector in the Rocket.Chat web client

This directory owns build, configuration and operation of this fork's browser
collector. The client connects to an existing Rocket.Chat server; it does not
start a second chat server. The reference client/server version is **7.10.0**.

The fork adds a startup module under `apps/meteor/client/akatsuki/`. It imports
the official SDK and `e2e` instance directly. Normal Rocket.Chat login, room keys
and the E2EE unlock flow stay in the official web client. The collector uses
the fork's `throwOnError` decryption option: account/room keys must be ready,
and cryptographic failures reject instead of becoming UI placeholder text.
The normal chat UI retains its existing error-display behavior.

## Build

From the fork root:

```sh
mise install node@22.16.0 deno@2.3.1 npm:meteor@3.3.0
npm_config_global=true npm_config_ignore_meteor_setup_exec_path=true \
  mise exec node@22.16.0 npm:meteor@3.3.0 -- meteor-installer install
mise exec node@22.16.0 -- npm --prefix akatsuki ci
mise exec node@22.16.0 deno@2.3.1 -- npm --prefix akatsuki run build
```

Meteor builds the fork and its browser bundle. The runtime host uses only
`.build/bundle/programs/web.browser`; no generated chat server is started.
Initial setup needs access to npm, Meteor's package distribution, GitHub and
Deno package sources. Set `METEOR_BINARY` if the Meteor CLI is installed at a
location other than `~/.meteor/meteor`.

## Connect to an existing server

```sh
ROCKET_CHAT_URL=https://chat.example.org \
AKATSUKI_API_URL=http://127.0.0.1:8000/api/reports/text \
  mise exec node@22.16.0 -- npm --prefix akatsuki start
```

Open **http://localhost:3200**, log in to the existing workspace and unlock E2EE
when prompted. Keep this browser origin and profile stable across restarts:
IndexedDB belongs to the origin/profile. The host binds only to loopback.

The host serves the forked browser assets and Meteor dynamic imports locally.
It obtains public runtime configuration from the existing server and proxies
Rocket.Chat HTTP/WebSocket traffic to `ROCKET_CHAT_URL`. The browser sends
decrypted reports directly to `AKATSUKI_API_URL` using CORS, with credentials
omitted. There is no Akatsuki report proxy in the host.

Allow the client origin in Akatsuki before starting its backend, for example
`CORS_ORIGINS=http://localhost:3200`. If opening the client at `127.0.0.1`, allow
`http://127.0.0.1:3200` instead (or include both, comma-separated). Keep other
existing allowed origins when setting this variable. For a client served over
HTTPS, the Akatsuki endpoint must also use HTTPS. The direct sender currently
targets an endpoint without browser authentication; `AKATSUKI_API_TOKEN` is no
longer used, and server-side secrets are not exposed to the browser.

| Environment variable | Meaning |
| --- | --- |
| `ROCKET_CHAT_URL` | Required existing server origin, HTTP(S), without a subpath |
| `AKATSUKI_API_URL` | Full report endpoint; defaults to `http://127.0.0.1:8000/api/reports/text` |
| `AKATSUKI_ROOM_IDS` | Optional comma-separated room IDs; otherwise all joined channels, private groups and DMs |
| `AKATSUKI_SINCE` | Optional ISO timestamp for the first capture; otherwise start from the server clock at first connection |
| `AKATSUKI_CLIENT_PORT` | Local host port; defaults to `3200` |
| `AKATSUKI_CLIENT_BUNDLE` | Override the generated `web.browser` directory |

Current reports identify the source as `rocket-chat:<server>:<room>` with
category `unknown`. Only the decrypted message body is sent as report text;
workspace, author, message IDs and timestamps are not prepended to it. Messages
with only attachments use an attachment metadata summary. Binary attachments
are not fetched. Change this mapping when unit identities are known.

## Cursor, delivery and recovery

Each account/server/Akatsuki-destination combination has its own IndexedDB
namespace. A Web Lock permits only one active collector per namespace across
tabs. Logging out stops collection and delivery for that account.

On first connection, the initial lower bound is saved before fetching history.
The collector establishes room subscriptions, then calls the official
`loadMissedMessages(roomId, savedTimestamp)` method once per room to retrieve
all messages posted after the saved timestamp. It saves decrypted reports to
the durable outbox before advancing the room cursor to the server time sampled
before the request. There is no client-side history pagination. Live messages
use the same outbox, so overlap is deduplicated. Subscription capture itself
does not advance a history cursor. History checks every 60 seconds keep the
recovery boundary moving during long sessions.

Disconnection cancels the capture session. After reconnection it resumes from
the committed room cursors. A failed decryption, history request or disk write
leaves the incomplete room interval unchanged. A browser restart reopens the
same outbox and cursors. Membership changes cause a new subscription/history
session so newly joined rooms are discovered.

The acquisition cursor is independent of delivery. Akatsuki being unavailable
does not stop capture. A report remains pending until a valid response contains
both a report ID and analysis-run ID. Delivery retries with backoff up to 60
seconds. The response acknowledges intake; it does not wait for analysis.

**Delivery is at least once.** The current Akatsuki endpoint has no idempotency
contract, so an acknowledgement lost after server acceptance can still produce
a duplicate. Accepted receipts are retained to deduplicate ordinary history
replay; there is no automatic retention limit yet. History recovers posts in
the selected timestamp interval, not offline edits/deletions of older posts.
The history response is not a server-side database snapshot; concurrent
deletion/import of historical messages needs separate change-sync validation.
E2EE and API compatibility must be checked against the actual deployed server
version.

The outbox contains decrypted text. Schema version/shape errors stop collection
without deleting data. For an explicit reset, stop/close collector tabs, back
up the database using browser developer tools, and delete only the named
`akatsuki-collector:<hash>` IndexedDB database. Reload to initialize fresh
storage. Clearing site data also removes login state and cursors.

## Separate local test server

Use a local test password, then launch the server independently:

```sh
ROCKET_CHAT_TEST_ADMIN_PASSWORD='choose-a-local-test-password' \
  docker compose -f akatsuki/compose.test-server.yml up -d
```

The server is at **http://localhost:3100**; log in as `collector-test-admin`
with that password. Point the client at `ROCKET_CHAT_URL=http://localhost:3100`.
This test deployment uses separate MongoDB storage and a pinned Rocket.Chat
7.10.0 image. Stop it with `docker compose -f akatsuki/compose.test-server.yml
stop`. Do not delete its volume unless intentionally discarding test history.

## Verification

```sh
mise exec node@22.16.0 -- npm --prefix akatsuki test
mise exec node@22.16.0 -- npm --prefix akatsuki run code-fix
mise exec node@22.16.0 -- npm --prefix akatsuki run test:browser
```

The browser smoke test needs the fork root dependencies and an installed Google
Chrome. It uses synthetic local history/stream and REST endpoints to verify
real IndexedDB recovery across tab closure and REST outages. It does not prove
compatibility with a deployed Rocket.Chat server or its E2EE setup.
