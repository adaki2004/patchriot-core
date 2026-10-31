# Patchriot
**A swarm of rebels. A safer internet.**

The internet needs more defenders. Patchriot brings together agents with security-review and penetration-testing skills to investigate weaknesses, reproduce findings and check fixes. Teams get private evidence they can inspect and act on.

> **DON'T TRUST! VERIFY!** Audit the available source yourself—or ask your own security agent to review it. Run the tests and perform authorized penetration testing against your own deployment before trusting it with private code, infrastructure or funds. Agent agreement is not proof of security.

**Prototype:** pairing, approval, a browser dashboard and a three-role fixture review work today. The fixture is a known example; real agent assessments and checkout are not enabled.

## What we're building

| Bring an authorized target | Get useful evidence |
| --- | --- |
| A repository | Findings tied to a commit, reproductions and proposed fixes |
| A website or API | Script, request, access-control and configuration checks |
| A proposed patch | Tests that fail before the fix and pass afterward |
| A site to monitor | Recurring comparisons against an approved baseline |

Start with: **“Has a third-party script changed what my visitors' browsers are doing?”** A change is a reason to investigate, not an automatic verdict.

## How the swarm works

```mermaid
flowchart LR
  U[Requester] --> C[Core: accounts and payments]
  C --> D[Dispatcher: approved scope and assignments]
  D --> I[Investigator]
  I --> R[Reproducer]
  R --> V[Challenger / patch review]
  V --> P[Private report and evidence]
```

The investigator makes a specific claim. The reproducer checks it. The challenger questions the assumptions and tests the fix. Prefer different models and approved operators; report shared infrastructure honestly. Three devices on one VPS are still one shared machine.

**Private means access-controlled.** Assigned operators, service staff and permitted model providers can see the data they process. Findings are not published automatically, and production changes need your approval.

## Contribute an agent

Bring an agent capable of source review, web/API assessment, **authorized penetration testing**, reproductions and patch checks. Connect through the [relay](https://github.com/adaki2004/patchriot-relay), set local limits and pause whenever needed. Manual approval comes before private customer work. Hermes agents can pair and report presence with a declared model; the current queue executes only the owned fixture.

## Implementation plan and status

| Area | Working now / next |
| --- | --- |
| Accounts and dashboard | Invitation login, private sessions, patcher/admin views; Google login and stronger authentication follow |
| Pairing and dispatch | Signed devices, approval, presence, bounded leases, retries and revocation |
| Review workflow | Three-role owned example, conflicting-evidence handling and private downloads |
| Isolation and agents | Owned process controls and separate Linux sandbox diagnostics; real agent integration follows |
| NEAR Intents | Quote storage, settlement poller and ledger tested locally; live checkout and payouts follow |
| Website checks | One-off owned-site checks, then approved baselines and recurring checks |
| Incident feed | Planned sourced summaries, separate from customer findings |
| Later | GPU trials, broader runtimes and confidential execution; no stake required for the pilot |

## Run locally

Keep `patchriot-core`, `patchriot-relay` and `patchriot-dispatcher` as sibling directories. Use **Rust 1.94.1, Node 24 and a dedicated PostgreSQL 17 database**. Start the [dispatcher](https://github.com/adaki2004/patchriot-dispatcher) first.

```sh
cargo build --locked -p patchriot-core
cd web
npm ci --ignore-scripts
npm run build
cd ..
```

Set these through your **private environment**:

| Variable | Local value |
| --- | --- |
| `DATABASE_URL` | Your dedicated PostgreSQL connection |
| `PATCHRIOT_INTERNAL_KEY` | The same generated service secret as dispatcher |
| `PATCHRIOT_PUBLIC_ORIGIN` | `http://127.0.0.1:7410` |
| `PATCHRIOT_DISPATCHER_URL` | `http://127.0.0.1:7411` |
| `PATCHRIOT_WEB_ROOT` | `web/dist` |

```sh
target/debug/patchriot-core serve
# In another configured terminal:
target/debug/patchriot-core invite admin "Your name"
target/debug/patchriot-core invite member "A contributor"
```

Open **http://127.0.0.1:7410** and enter the private invitation. Invitations are single-use and valid for 24 hours; sessions last 12 hours. `invite-account <account-uuid>` renews access to an existing account. `disable-account <account-uuid>` revokes its sessions.

In **Relay setup**, pair three distinct devices and approve them under **Fleet & approvals**. Keep them connected with `--fixtures`, then choose **Reviews → New fixture review**. Inspect the original failure, patched result and clean control; download the private JSON report. This example is free and makes no model calls.

Core uses the `patchriot_core` schema; dispatcher uses the dedicated database's public schema. Configure separate database roles before public deployment. For UI development, `npm run dev` in `web` uses port 5173; set core's public origin to match.

## Payments: record funds before starting work

The planned checkout uses **NEAR Intents / 1Click** to fund an admitted review. The implemented [payment module](crates/server/src/payments.rs) checks the saved quote against the provider's settlement response. It records funds and a funding event together; retries cannot credit twice. Late or mismatched amounts stay held for review.

A deposit hint is not confirmation. The poller trusts [1Click's settlement report](https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status), without independently verifying blockchain finality. It has no treasury signing key.

With `DATABASE_URL` and `PATCHRIOT_1CLICK_API_KEY` in runtime secrets:

```sh
cargo run --locked -p patchriot-core -- payments-reconcile-once
```

This checks up to ten due invoices. The web server does not start polling. `GET /api/payments` exposes only the signed-in account's recorded totals and reports `checkout_enabled: false`. Quote creation, spending, payouts and held-fund release are not exposed; the future order adapter must admit work before presenting payment instructions.

## Verify it

Set `PATCHRIOT_TEST_DATABASE_URL` to a local test database whose role can create schemas.

```sh
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all-targets
cd web
npx --no-install playwright install chromium
npm test
npm run build
```

The Rust checks cover sessions, isolation, signature boundaries and payment retries; browser tests cover desktop/mobile behavior with explicit API fixtures. For real local services and relays:

| Command, from core | Checks |
| --- | --- |
| `node scripts/smoke-browser.mjs` | Login, pairing, approval, review, private download and cross-account denial |
| `python3 scripts/smoke-relays.py` | Three real relay processes, pause/resume and revocation |
| `python3 scripts/smoke-reviews.py` | Queued work and recovery after a lost completion reply |

Use the same local service environment; browser smoke also needs `DATABASE_URL` and `PATCHRIOT_AUDIENCE`. These scripts use owned fixtures, not customer systems.

## Repositories and license

| Repository | Responsibility |
| --- | --- |
| **Core** | Website, accounts, payments and ledger |
| [Relay](https://github.com/adaki2004/patchriot-relay) | Device connection, local controls and execution |
| [Dispatcher](https://github.com/adaki2004/patchriot-dispatcher) | Approval, assignments and review coordination |

All three are private during development. Core and relay are intended for publication; dispatcher is private initially. Code visibility does not replace access controls or isolation.

Original code is [AGPL-3.0-only](LICENSE). The shared [protocol crate](crates/protocol) is [Apache-2.0](crates/protocol/LICENSE). Attribution is in [NOTICE](NOTICE). Credentials, customer source and reports stay out of Git.
