# Getting Started — Rocket.Chat local development

**Who this is for:** developers new to the monorepo who want to run Rocket.Chat
from source for the first time.

**After reading this you will have:** the app running at
`http://localhost:3000`, logged in as an admin user, ready to edit code with hot
reload.

> Goal: clone → app running in under ~30 min (excluding download time).

---

## 1. Prerequisites

| Tool | Version pinned in | How to get it |
|-----------|--------|-----------|
| Node.js | `package.json` → `volta.node` (`engines.node` is the accepted range) | [Volta](https://volta.sh) picks it automatically, or `fnm`/`nvm install <version>` |
| Yarn | `package.json` → `packageManager` | Ships via Corepack: `corepack enable` |
| Meteor | `apps/meteor/.meteor/release` | the [installer](https://docs.meteor.com/about/install.html) |
| Git | any recent | — |

Building from source needs **16 GB of RAM or more**. **Use exactly the pinned
versions** — mismatches cause obscure build errors.

Check everything at once; the script reads the pins from the repo:

```bash
./scripts/check-deps.sh            # report what is missing or on the wrong version
./scripts/check-deps.sh --install  # install what it can
```

MongoDB is **not required** for the first run: Meteor starts a bundled Mongo,
which already runs as a single-node replica set — enough for the transactions
and change streams the app relies on. You only need an external Mongo to mirror
production or to inspect data with an external client (see section 5).

---

## 2. Clone and install

```bash
git clone https://github.com/RocketChat/Rocket.Chat.git
cd Rocket.Chat
./scripts/check-deps.sh --install   # Node, Yarn and Meteor at the pinned versions
yarn                                # installs all workspaces (slow the first time)
```

This is a monorepo (Yarn workspaces + Turborepo). Running `yarn` at the root
installs `apps/*`, `packages/*` and `ee/*` at once. Do not run `yarn` inside
subfolders.

---

## 3. Run the app

From the **root** of the repository:

```bash
yarn dev
```

This runs `turbo run dev`, which builds the required packages and starts the
Meteor app in `apps/meteor`. Once you see the server listening, open:

```text
http://localhost:3000
```

On the first run the Setup Wizard asks you to create the **admin** user and the
organization. That's it — you are running.

Hot reload is active: editing files in `apps/meteor` recompiles and reloads.

> The first Meteor compilation is slow (several minutes). Subsequent ones use
> the cache and are much faster.

### Lighter alternative: run Meteor alone

The root `yarn dev` runs `turbo run dev --env-mode=loose --parallel --filter=@rocket.chat/meteor...`,
which **builds and watches every workspace package** the app depends on. That's
correct but heavy — lots of `tsc --watch` processes and CPU.

If you are only touching `apps/meteor` and your packages are already built, run
Meteor directly without the package watchers:

```bash
# once, to build all dependency packages (or run root `yarn dev` once and Ctrl+C)
yarn build

# then run only the Meteor app — no package watching
cd apps/meteor
yarn dev
```

Trade-off: changes inside `packages/*` won't recompile automatically. When you
edit a package, rebuild just that one (see below) — Meteor picks up the new
`dist` on its next reload.

### Build or watch a single package

Use Yarn workspaces to act on one package without touching the rest:

```bash
# build a single package once
yarn workspace @rocket.chat/core-typings run build

# OR watch just that package (tsc --watch) in a separate terminal
yarn workspace @rocket.chat/rest-typings run dev
```

Pattern: `yarn workspace <package-name> run <script>`. The package name is the
`"name"` field in that package's `package.json` (e.g. `@rocket.chat/models`,
`@rocket.chat/ui-client`). Most packages expose `build` (one-shot) and `dev`
(`tsc --watch`).

Recommended light loop: `cd apps/meteor && yarn dev` in one terminal, and
`yarn workspace <pkg> run dev` only for the package(s) you are editing.

---

## 4. Environment variables

Rocket.Chat is configured through environment variables. All are **optional**
for the first run — with none set, the app boots on the bundled Mongo. A var
exported in your shell is picked up on the next start. The most used ones:

| Var | Purpose |
|-----|----------|
| `PORT` | HTTP port (default `3000`) |
| `ROOT_URL` | public URL; must match how you open it in the browser |
| `MONGO_URL` | point at an external Mongo instead of the bundled one (see section 5) |
| `ROCKETCHAT_LICENSE` | enables Enterprise (EE) features |

---

## 5. (Optional) External MongoDB

The bundled Mongo already covers local dev. Set up an external one only to
mirror production or to point external tooling at the data.

Rocket.Chat needs a replica set — not for the oplog (Meteor oplog tailing is
disabled; real-time is handled by the streamer), but because transactions and
change streams require it. A single-node replica set is enough:

```bash
docker run -d --name rc-mongo -p 27017:27017 \
  mongodb/mongodb-community-server:8.0-ubi8 \
  mongod --replSet rs0 --bind_ip_all
docker exec rc-mongo mongosh --eval "rs.initiate()"
```

Then point the app at it by **exporting in your shell** before `yarn dev`
(Meteor does not load a `.env` file):

```bash
export MONGO_URL='mongodb://localhost:27017/rocketchat?replicaSet=rs0'
```

---

## 6. Run modes

| Command | What it does | When to use |
|---------|-----------|-------------|
| `yarn dev` | Monolithic Meteor app | **default** — day-to-day development |
| `yarn ms` | Microservices mode (transporter, default TCP) | working on services (presence, ddp-streamer, authorization…) |
| `yarn storybook` | Component Storybook on port 6006 | developing UI in isolation |
| `yarn build` | Full monorepo build (Turbo) | validate build / local CI |

---

## 7. Run the tests

| Command (in `apps/meteor`) | Type |
|-----------|------|
| `yarn testunit` | unit (definition + jest + mocha server, with coverage) |
| `yarn testapi` | API tests (mocha, needs a running server) |
| `yarn test:e2e` | end-to-end (Playwright) |
| `yarn lint` | stylelint + meteor lint + eslint |
| `yarn typecheck` | `meteor lint` + `tsc --noEmit` |

From the root, `yarn testunit` and `yarn lint` run via Turbo across all
workspaces.

---

## 8. Stuck?

See [local-dev/troubleshooting.md](./local-dev/troubleshooting.md) — Watchman,
file watching, processes that won't die, Mongo, ports.

If you get stuck on something **not** documented there: open an issue with the
`docs` label (or a short PR fixing this guide). That's the mechanism — every
new-dev blocker becomes a doc improvement.
