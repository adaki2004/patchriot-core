<p align="center"><img src="docs/assets/patchriot-banner.png" alt="Your webapp, our AI swarm. See what hackers see." width="1000"></p>

# Patchriot

**Pre-penetration testing for your web app.** Point Patchriot at your website. Agents map its exposed surface, investigate potential weaknesses and return a private report with evidence and suggested fixes.

Hermes agents combine Kali tools with **uncensored/abliterated models**. The recommended setup uses **NEAR AI’s private Trusted Execution Environments (TEEs)** for inference, with **Venice as a fallback**.

An extra pair of eyes for developers and security researchers—not a replacement for a human penetration tester. Start with public pages or add a disposable account to check behind the login. Source-code assessment is planned.

[Use Patchriot](https://patchriot.net) · [How it works](https://patchriot.net/#/docs/workflow) · [Checks and tools](https://patchriot.net/#/docs/checks) · [Run locally](#run-locally) · [For judges](judges.md)

### Choose your starting point

<table width="100%">
<thead><tr>
<th width="33%">Black box · available</th>
<th width="33%">Grey box · available</th>
<th width="33%">White box · planned</th>
</tr></thead>
<tbody>
<tr>
<td align="center"><img src="web/public/brand/product-blackbox.jpg" alt="Public website assessment" width="260"></td>
<td align="center"><img src="web/public/brand/product-greybox.jpg" alt="Authenticated website assessment" width="260"></td>
<td align="center"><img src="web/public/brand/product-whitebox.jpg" alt="Source-assisted assessment roadmap" width="260"></td>
</tr>
<tr>
<td valign="top"><strong>Your URL.</strong> Public pages, observed APIs and selected security checks.</td>
<td valign="top"><strong>Your URL + test access.</strong> Signed-in checks and account comparisons where possible.</td>
<td valign="top"><strong>Your code + deployment.</strong> Planned: a <strong>Red Team Sandbox (RTS)</strong> to investigate source-level weaknesses and validate them in an isolated test environment. Not available yet.</td>
</tr>
</tbody>
</table>

Verify ownership, choose your checks, confirm the scope, then start with credit or a coupon. **Scout investigates; Recon rechecks findings and explores missed leads.** The report preserves disagreements and coverage gaps, even when both agents finish.

## Architecture

![Core highlighted: website and accounts connect to the dispatcher, which schedules isolated agents. NEAR Intents handles payments; model providers serve the agents.](docs/assets/architecture.png)

| Repository | Responsibility |
| --- | --- |
| **[patchriot-core](https://github.com/adaki2004/patchriot-core)** · you are here | Website, accounts, checkout, credit ledger and shared protocol types |
| [patchriot-dispatcher](https://github.com/adaki2004/patchriot-dispatcher) | Ownership checks, approved worker pool, scheduling and private reports |
| [patchriot-relay](https://github.com/adaki2004/patchriot-relay) | Pairs an agent machine and enforces its scope, credentials and execution limits |

Core and dispatcher run as services. Agents run on separate Linux machines, commonly Kali, inside restricted containers. Each role goes to a different approved device; devices may share a host or operator. The relay keeps provider keys outside the container and checks every target request. The agent-facing gateway exposes no internal administration routes.

## Two NEAR building blocks

- **[NEAR AI](https://docs.near.ai/cloud/verification):** the NEAR inference route encrypts model exchanges and verifies attestation and response signatures. This covers the model service, not the Kali host or the correctness of a finding.
- **[NEAR Intents / 1Click](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api):** converts supported crypto into service credit. Core credits a top-up only after matching, confirmed settlement; a transaction hash alone is insufficient.

NEAR AI and Venice can be primary or backup, as configured by the operator and disclosed at checkout. Reports record the route actually used. The Venice route does not claim Patchriot-verified NEAR attestation. [Data handling](https://patchriot.net/#/docs/privacy).

## Tools

| Tool | Use in an assessment |
| --- | --- |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Investigate evidence, plan follow-up checks and validate claims |
| [Patchriot adapters](https://github.com/adaki2004/patchriot-relay/tree/main/agent) | Headers, scoped discovery, access comparisons and evidence records |
| [Nuclei](https://github.com/projectdiscovery/nuclei) | Curated HTTP signatures; no unrestricted template packs |
| [ARES-derived fingerprints](https://github.com/Mafifrizi/ARES) | Selected technology and exposed-path signatures; not the full framework |
| [ffuf](https://github.com/ffuf/ffuf) | Bounded candidate-path discovery with missing-page controls |
| [ZAP](https://www.zaproxy.org/) | Passive checks and a selected reflected-input rule when authorized |
| [Schemathesis](https://github.com/schemathesis/schemathesis) | Read cases from a discovered API schema; no schema means not applicable |
| [Chromium](https://www.chromium.org/), [Playwright](https://github.com/microsoft/playwright), [agent-browser](https://github.com/vercel-labs/agent-browser) | Scoped browser exploration and sign-in |

Choose the check groups before starting. Reports show **what actually ran**, its version and the supporting requests. A tool being installed does not mean it ran, and a scanner match is not automatically a confirmed vulnerability.

## Inside an audit

<table>
<tr>
<td width="33%" align="center"><a href="docs/assets/audit-findings.png"><img src="docs/assets/audit-findings-preview.png" width="280" alt="Preview of a finding and its supporting evidence"></a></td>
<td width="33%" align="center"><a href="docs/assets/audit-activity.png"><img src="docs/assets/audit-activity-preview.png" width="280" alt="Preview of the recorded tools and investigation stages"></a></td>
<td width="33%" align="center"><a href="docs/assets/audit-exposure.png"><img src="docs/assets/audit-exposure-preview.png" width="280" alt="Preview of observed routes and access contexts"></a></td>
</tr>
<tr>
<td width="33%"><strong>Findings & evidence</strong><br>Inspect a finding and the suggested fix.</td>
<td width="33%"><strong>Activity graph</strong><br>Trace the checks and agent follow-up.</td>
<td width="33%"><strong>What your site exposes</strong><br>Explore reachable routes and responses.</td>
</tr>
</table>

*Click a preview for the full-size screenshot. Actual interface, fictional example data. Observed exposure is separate from vulnerabilities.*

## Run locally

**From three repositories to your first local audit.** Follow this guide on macOS or Linux:

1. **Install and build** — check the prerequisites, clone all three repositories and build the services.
2. **Prepare the databases** — start PostgreSQL in Docker and fill in the service settings.
3. **Start and sign in** — create your local admin account and open the website.
4. **Connect inference** — configure NEAR AI as primary and Venice as backup using your own keys.
5. **Pair two agents** — approve their HTTP capabilities and bring them online.
6. **Prepare an audit** — add a website you own, verify ownership and optionally supply a test account.
7. **Start and follow the results** — use the UI or the supplied script to run an HTTP-only assessment.

> **Want your coding agent to set it up?** Give it this README and ask: “Follow the Run locally guide, set up all three Patchriot repositories with NEAR AI and Venice backup, then help me submit my first audit. Ask me for missing credentials and keep them out of Git.”

Everything needed for this local setup is below. The other READMEs are component references; **Contributing** contains optional checks for code changes.

Use fresh databases and your own credentials. If you only want an assessment, use the [hosted service](https://patchriot.net).

### 1. Prerequisites and build

| Install locally | Used for |
| --- | --- |
| Git and a native build toolchain | Clone and build the services. On macOS, install Xcode Command Line Tools with `xcode-select --install`; on Linux, install your distribution's C compiler and linker. |
| [Rust](https://www.rust-lang.org/tools/install) | The repositories pin Rust **1.94.1** through `rust-toolchain.toml`. |
| [Node.js](https://nodejs.org/en/download) **24.22.1** with npm | Build the website. |
| Python **3.10+** and OpenSSL | Local setup helper and secret generation. No Python packages are required. |
| [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/) or [Docker Engine for Linux](https://docs.docker.com/engine/install/) | PostgreSQL and the bundled Hermes/tools image. Start Docker before continuing. |

Allow at least **4 GiB for one running agent**, plus memory for PostgreSQL, and roughly **7 GB for the agent image**, plus build space. You also need a supported inference provider key with credit, a public HTTPS application you are authorized to test and a disposable test account.

**No separate Linux VM, Kali installation, GPU or model download.** Core, dispatcher and the trusted relay run natively; Docker supplies PostgreSQL and isolated agent containers. The tested macOS path covers HTTP checks and JSON/cookie login. Full browser checks require the Linux sandbox support described in the [relay setup](https://github.com/adaki2004/patchriot-relay#run-an-agent).

Clone all three as siblings: dispatcher and relay depend on the protocol crate in core. Use matching revisions when developing across branches.

```sh
mkdir patchriot-local
cd patchriot-local
git clone https://github.com/adaki2004/patchriot-core.git
git clone https://github.com/adaki2004/patchriot-dispatcher.git
git clone https://github.com/adaki2004/patchriot-relay.git
cd patchriot-core
cargo build --locked -p patchriot-core
cd web
npm ci --ignore-scripts
npm run build
cd ../../patchriot-dispatcher
cargo build --locked
cd ../patchriot-relay
cargo build --locked
```

### 2. Create databases and configure services

Run PostgreSQL in Docker; there is no host PostgreSQL installation to manage. The following keeps its password outside all three repositories and binds the database to localhost:

```sh
cd ../patchriot-core
umask 077
python3 -c 'import secrets; print("POSTGRES_PASSWORD=" + secrets.token_hex(24))' > ../local-db.env
docker run --detach --name patchriot-local-db \
  --publish 127.0.0.1:54329:5432 \
  --env-file ../local-db.env \
  --env POSTGRES_USER=patchriot_dev --env POSTGRES_DB=patchriot_core \
  --mount source=patchriot-local-db,target=/var/lib/postgresql/data \
  postgres:17
docker exec patchriot-local-db pg_isready -U patchriot_dev -d patchriot_core
```

Wait until `pg_isready` reports **accepting connections**, then create dispatcher's separate database and configuration files:

```sh
docker exec patchriot-local-db createdb -U patchriot_dev patchriot_dispatcher
cp .env.example .env
cp ../patchriot-dispatcher/.env.example ../patchriot-dispatcher/.env
chmod 600 .env ../patchriot-dispatcher/.env
openssl rand -hex 32
```

Put that generated service secret into `PATCHRIOT_INTERNAL_KEY` in **both** files. Use the password from `local-db.env` in each database URL: `postgresql://patchriot_dev:PASSWORD@127.0.0.1:54329/patchriot_core` for core and the same connection ending in `/patchriot_dispatcher` for dispatcher. Never share a database between services. If port 54329 is occupied, choose another localhost port in both the Docker command and URLs.

| Minimum setting | Core | Dispatcher |
| --- | --- | --- |
| `DATABASE_URL` | Your `patchriot_core` connection | Your `patchriot_dispatcher` connection |
| `PATCHRIOT_INTERNAL_KEY` | The same generated secret | The same generated secret |
| Browser origin | `PATCHRIOT_PUBLIC_ORIGIN=http://127.0.0.1:7410` | — |
| Internal URL / listener | `PATCHRIOT_DISPATCHER_URL=http://127.0.0.1:7411` | `PATCHRIOT_BIND=127.0.0.1:7411` |
| Signature audience | — | Keep `PATCHRIOT_AUDIENCE=patchriot-local-v1`; use it when pairing |
| Local checkout | Set `PATCHRIOT_REVIEW_MODE=coupons` | — |
| Trial time allowance | — | Set `PATCHRIOT_AGENT_ATTEMPT_SECONDS=900`; match it in relay settings |

The templates explain defaults and optional settings inline. Grey-box testing additionally needs a **separately generated** `PATCHRIOT_CREDENTIAL_KEY` in dispatcher. Keep it stable: it encrypts saved test credentials. Leave extra testing context empty unless you configure its optional OpenRouter screening key. OAuth, analytics, treasury and 1Click keys are **not required** for local password sign-in and coupon testing.

### 3. Start and sign in

The binaries do not read `.env` automatically. Use a separate terminal for each service:

```sh
# Terminal A, inside patchriot-dispatcher
set -a; . ./.env; set +a
target/debug/patchriot-dispatcher
```

```sh
# Terminal B, inside patchriot-core
set -a; . ./.env; set +a
umask 077
openssl rand -base64 36 > ../local-admin-password.txt
target/debug/patchriot-core bootstrap-admin local_admin ../local-admin-password.txt
target/debug/patchriot-core serve
```

Migrations run at startup. Open **http://127.0.0.1:7410**, choose password sign-in and use `local_admin` with the private password file. Keep using this exact origin: `localhost` and `127.0.0.1` are different origins.

### 4. Configure NEAR AI and its backup

The inference keys go **on the relay machine**, in private files. They do not belong in core or dispatcher `.env`. Get a funded [NEAR AI key](https://docs.near.ai/cloud/quickstart) and a [Venice key](https://docs.venice.ai/api-reference/api-spec). This example uses **NEAR first, Venice as backup**. The report records the provider actually used.

| File | What belongs there |
| --- | --- |
| `patchriot-core/.env` | Website, database, service secret and optional sign-in/payment settings |
| `patchriot-dispatcher/.env` | Scheduler, database, credential encryption and model selection |
| `local-secrets/near-ai.key` | Your NEAR AI inference key; read only by the trusted relay |
| `local-secrets/venice.key` | Your Venice backup inference key; read only by the trusted relay |
| `local-secrets/agent.json` | Image ID, Docker socket, model names, limits and paths to those key files |

Build the agent image. Hermes and the tools are inside; there is no separate Hermes installation:

```sh
# From patchriot-core
cd ../patchriot-relay
docker build -t patchriot-agent:local agent
mkdir -p ../local-secrets
chmod 700 ../local-secrets
```

Create the private settings below. The two prompts hide the keys, and nothing is sent to a provider at this step. Run once; existing files are deliberately not overwritten.

```sh
python3 - <<'PYCONFIG'
import getpass, json, os, subprocess
from pathlib import Path
folder = Path('../local-secrets').resolve()
config = json.loads(Path('agent-settings.example.json').read_text())
for field, filename, label in [
    ('live_provider_key_file', 'near-ai.key', 'NEAR AI key'),
    ('secondary_key_file', 'venice.key', 'Venice backup key'),
]:
    value = getpass.getpass(label + ': ').strip()
    if not value or not value.isascii() or any(c.isspace() for c in value):
        raise SystemExit('A nonempty API key is required.')
    path = folder / filename
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
        f.write(value)
    config[field] = str(path)
config['image'] = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', 'patchriot-agent:local'], text=True).strip()
socket = subprocess.check_output(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], text=True).strip()
if not socket.startswith('unix://'):
    raise SystemExit('This local guide requires a local Unix Docker socket.')
config['docker_socket'] = socket.removeprefix('unix://')
with os.fdopen(os.open(folder / 'agent.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
    json.dump(config, f, indent=2)
print('Private settings created; no inference started.')
PYCONFIG
```

In **dispatcher `.env`**, uncomment these two settings, then restart its terminal with the updated environment:

```sh
PATCHRIOT_INFERENCE_PRIMARY_MODEL=deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated
PATCHRIOT_INFERENCE_SECONDARY_MODEL=deepseek-v4-1-flash-1017-uncensored
```

Keep `PATCHRIOT_INFERENCE_BALANCED_POOLS=false` and `PATCHRIOT_VENICE_FALLBACK_ENABLED=false`. Backup use requires consent at checkout; it does not bypass failed attestation or exhausted budgets. To run with NEAR alone, omit `secondary_model` and `secondary_key_file` from the private JSON and leave the dispatcher secondary setting unset.

### 5. Pair two local agents

Still in `patchriot-relay`, initialize the first device:

```sh
target/debug/patchriot-relay init \
  --state-dir ../local-agent-one \
  --dispatcher http://127.0.0.1:7411 --audience patchriot-local-v1 \
  --label "Local agent one" --compute-group "my-machine" \
  --runtime hermes --runtime-version 0.22.5 \
  --model deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated
target/debug/patchriot-relay pair --state-dir ../local-agent-one
```

In the website: **Agent approvals → Pair a relay**. Enter the displayed code, approve the device, then **Allow private reviews**. Enable **Live website tests** and these four capabilities only: **Web and API checks**, **Signed-in HTTP requests**, **Session login**, **Extra context and site gates**. Leave browser and untested scanner capabilities unchecked for this local trial.

Repeat with `../local-agent-two` and label `Local agent two`. Keep the same `my-machine` compute group: the two roles run sequentially on this one computer. Start each device in its own terminal, changing only the state directory:

```sh
# Inside patchriot-relay; use local-agent-two in the second terminal.
target/debug/patchriot-relay doctor \
  --state-dir ../local-agent-one --agent-config ../local-secrets/agent.json
target/debug/patchriot-relay connect \
  --state-dir ../local-agent-one --agents --live-tests \
  --agent-config ../local-secrets/agent.json
```

Confirm both are online in **Agents**. See the [relay README](https://github.com/adaki2004/patchriot-relay#run-an-agent) for the Linux browser sandbox and remote operation.

### 6. Prepare your first audit

The helper selects the HTTP-only scope that works on Docker Desktop. Run it from `patchriot-core` with a public HTTPS application you are authorized to test. For grey box, supply a JSON login that sets a cookie and a GET endpoint that refuses anonymous access:

```sh
python3 scripts/local-audit.py \
  --password-file ../local-admin-password.txt --state ../local-audit.json \
  prepare --target https://your-staging.example.com \
  --login-path /api/auth/login --check-path /api/me
```

For **black box**, omit both path arguments. No testing starts yet. Open the printed setup URL and verify ownership with DNS or a recorded admin approval. This helper cannot bypass ownership. It runs real HTTP investigation, but does not discover the login through a browser or run the full scanner suite. The hosted site's new-test flow uses browser-capable Linux agents.

Create a one-use coupon in a core terminal with `.env` loaded:

```sh
target/debug/patchriot-core review-code local-test
```

**Coupons bypass payment, not inference costs.** The local settings allow 15 minutes per role; this is a ceiling, not a promised duration.

### 7. Start in the UI—or through the API helper

**UI:** open the prepared setup, save a disposable target account for grey box, confirm the two agents and NEAR/Venice processing, enter the coupon, then **Confirm & start test**. Leave extra testing context empty unless you configured its screening key. Open **Audits** to follow the graph, findings and observed surface; use **Download Audit** for the report.

**Script:** after ownership verification, save the coupon alone in `../local-coupon.txt` and the target account in `../local-target-account.json` as `{"username":"YOUR_TEST_USER","password":"YOUR_TEST_PASSWORD"}`. Keep both files outside Git and make them owner-only. Then:

```sh
chmod 600 ../local-coupon.txt ../local-target-account.json
python3 scripts/local-audit.py \
  --password-file ../local-admin-password.txt --state ../local-audit.json \
  start --credentials-file ../local-target-account.json \
  --coupon-file ../local-coupon.txt \
  --accept-test-risk --accept-private-processing
```

Omit `--credentials-file` for black box. Inspect the target and named operators/providers printed by the helper, then type `START`. It uses the same credential, preparation and coupon APIs as the UI and prints the report link. It saves submission state before checkout; after an interrupted response, inspect **Audits** instead of blindly submitting again. Use either start method for a setup, not both.

**Verified locally:** macOS on Apple silicon, Docker Engine 29.3.0 through Docker Desktop, PostgreSQL 17, real Hermes inference through Venice, cookie login with an anonymous control, two completed roles and confirmed cleanup. This was an HTTP-only trial, not the full browser/scanner suite. Live targets must resolve to public addresses; localhost and private-network targets are intentionally rejected.

To stop the installation, let active work finish, then stop the two relay terminals and both service terminals with Ctrl+C, followed by `docker stop patchriot-local-db`. `docker start patchriot-local-db` preserves the databases. Keep the generated secrets and device state for the next start; do not rerun bootstrap, recreate databases or regenerate keys.

## Operating your installation

| Area | Configuration and behavior |
| --- | --- |
| Sign-in | Local admin passwords work without OAuth. Optional Google/GitHub callbacks and the Reown project ID are documented in [.env.example](.env.example). |
| Payments | Set your 1Click key and a reviewed checkout policy before enabling `paid`; run `patchriot-core payments-run` separately. See the typed [checkout policy](crates/server/src/payments/access.rs) and [tests](crates/server/src/payments/checkout_tests.rs). |
| Exact top-ups | Send the quoted asset, network and **exact input amount** before expiry. Conversion costs can make the input larger than the credited dollars. An underpayment does not create credit; keep the deposit receipt for recovery. |
| Accounting | Confirmed credit is reserved before work. Paid work uses a 90/10 operator/platform allocation. Coupons do not fund payouts. Keep the payout signer in its separate process. |
| Private access | Only the requester and authorized staff can read reports. Assigned operators and approved model providers process task data; this is not end-to-end secrecy from them. |
| Deployment | Use HTTPS, separate service databases, a private internal dispatcher and its agent-only gateway. Service examples are in [deploy/](deploy/). Never expose the internal service secret to browsers or agents. |
| Retention | The first report export starts a fixed 12-hour deletion timer. Inspect backup and operator retention separately. |

## Contributing

<details>
<summary>Checks after changing the code</summary>

Run these from the core repository before proposing a code change. They check the source; they do not start the services or submit an audit.

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
cd web
npm run build
```

Database integration tests additionally need `PATCHRIOT_TEST_DATABASE_URL` pointing to a separate disposable database. Keep it separate from the installation you use for assessments.

</details>

[Security boundaries](SECURITY.md) · [License](LICENSE) · [Third-party credits](NOTICE)

> **DON’T TRUST! VERIFY!** Review this source and the agent image yourself, or ask your own security agent to inspect them. Test only with the owner's permission. Even read requests can affect a live service; use staging and disposable accounts where possible.
