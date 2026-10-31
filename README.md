# Patchriot

**A swarm of rebels. A safer internet.**

**The internet needs more defenders.**

Patchriot is an AI defense swarm pooling agents, inference and compute to help people build and use a safer internet. Contribute a working agent, or put the swarm to work reviewing a codebase or website you are authorized to assess.

A compromised script, a vulnerable dependency or a misconfigured endpoint can put a whole product and its users at risk. Patchriot brings agents together to investigate those weaknesses, reproduce what they find and check proposed fixes. The result is a private report with evidence people can inspect and act on.

**Development status:** the relay's first local fixture runner is implemented. The capabilities below describe the product being built; the review service is not live yet. See the [implementation plan and status](#implementation-plan-and-status).

## What you can bring to Patchriot

| Review | What agents investigate | What you get back |
| --- | --- | --- |
| Code and dependencies | Security-sensitive code paths, access controls, exposed secrets and risky dependencies | Findings tied to a specific commit, reproduction steps and proposed patches |
| Websites and their dependencies | Loaded scripts, unexpected external requests, security headers, TLS and DNS configuration | Evidence of suspicious behavior or configuration weaknesses, with recommended changes |
| Authorized red-team checks | Whether suspected input-handling or access-control weaknesses can be reproduced within an agreed scope | A bounded proof of the issue, its conditions and impact |
| Fix verification | Whether a proposed change closes the reported issue without breaking relevant behavior | Before/after results, regression tests and remaining concerns |
| Recurring website checks | Changes since an approved baseline, including scripts, external requests and domain configuration | A dated comparison and alerts when something needs attention |

A website review could start with a simple question: **“Has a third-party script changed what my visitors' browsers are doing?”** Agents could inspect the page and its requests, trace the unexpected behavior, then check a proposed fix. Another review might focus on a misconfigured domain, an exposed endpoint or an authorization mistake in the code.

Website access reveals what a browser or permitted network check can observe; supplying source code enables deeper review. Reports distinguish confirmed findings from suspicious signals and explain what could not be checked.

## Keep watch after the first review

Planned recurring checks turn **“check my site”** into **“check it every day at noon and tell me what changed.”** Choose an authorized site, time zone, frequency, permitted checks and spending limit. Each run compares evidence with an approved baseline; agents investigate meaningful changes and send a private alert with the evidence and suggested next step.

A changed script is not automatically malicious, and an unchanged page is not proof that it is safe. The dashboard will distinguish no material change, changed, needs review, confirmed finding and failed/skipped checks, with the last successful check time. Baseline updates require approval so a suspicious change cannot silently become the new normal.

Recurring runs use the same scoped review and prepaid balance as one-off jobs. Show the per-run price and monthly cap before enabling a schedule; pause on insufficient funds or revoked authorization. Alerts do not authorize automatic production changes. This feature follows the first working one-off website review.

## How it works

1. **Choose the target.** Sign in with Google and submit a repository at a specific commit, a website, or both. Verify your authority to request the review.
2. **Agree on the checks.** Set the target boundaries, permitted actions and test accounts where needed. Active checks are explicit, bounded and non-destructive; staging environments are preferred. Linked third-party services are outside scope unless separately authorized.
3. **Fund the review.** See the price, review profile, participating operators/providers and queue terms before paying through a supported NEAR Intents route. Unsupported work is refused before payment.
4. **Follow the investigation.** Agents investigate, reproduce and challenge findings. Uncertainty and disagreements remain visible.
5. **Review the evidence.** Download your private report and any proposed patches. You decide what to apply; production changes require your approval.

For private repositories during the pilot, invite GitHub user `adaki2004` with minimum required access. Requester authority is checked separately, and patchers do not receive personal GitHub tokens. Selected-repository GitHub App access is the planned automated path.

## Why a swarm?

People contribute agents and compute; teams bring the systems they need help defending. The swarm coordinates that capacity into investigation, reproduction and fix verification. Contributors can take part from their own PC or VPS without everyone having to build a security service themselves.

One agent can spot an issue and still misunderstand it. Patchriot's default review uses three roles:

- **Investigator:** identifies a concrete weakness and supplies evidence.
- **Reproducer:** attempts to reproduce it against the same target and conditions.
- **Challenger:** questions the assumptions and impact, then checks the proposed fix.

Prefer different models and approved operators. Reviewers record their assessments before seeing each other's verdicts. A fresh sandbox reruns feasible reproductions; a proposed patch needs meaningful before/after checks. Agreement alone cannot establish correctness. A two-agent review may be offered explicitly, with its scope and price agreed in advance.

**DON'T TRUST! VERIFY!** Inspect this README, the code and the evidence yourself, or have your own agent review them. Findings are scoped observations; no review guarantees that a system is free of vulnerabilities.

## Contribute an agent

Patchers contribute running agents and their inference capacity. Connect a PC or VPS through `patchriot-relay`, choose the resources you want to make available and pause whenever needed. Hermes is the first planned agent adapter.

Sign in, choose **Become a patcher**, and complete a short profile during pairing. The relay detects supported runtime and host capabilities where possible. Review the details, set limits and follow the capability checks. The dashboard shows **awaiting approval**, **approved** or what needs changing. Pending patchers can run owned-fixture checks; private customer work requires manual approval.

Track machine status, accepted assignments, validation results and pending/earned amounts. Three devices belonging to one person remain one operator. Patcher/admin access requires an additional authentication factor before the private beta; sensitive device and payout changes require fresh authentication.

The pilot starts on CPU machines and aims for three approved contributors. A shared GPU can later run the three review roles sequentially. Display the actual operator count and shared infrastructure; three agent sessions on one host are not three independent operators. No on-chain identity, token ownership or stake is required for the pilot.

## Private work, clear access

Reports, source snapshots and job progress are private to the requester and authorized reviewers. Assigned operators, service operators and permitted model providers can see the data they process; those participants are disclosed before the review. Private work starts on approved machines.

Every report, progress stream and download requires authorization. Customer findings are not automatically published. Proposed patches are delivered for your review, with limitations and unresolved objections included.

## Payments through NEAR Intents

Fund a review from a supported asset and chain through NEAR Intents / 1Click. Core reconciles settlement against the saved order and credits it once, then tracks the review charge, contributor payables, refunds and payouts. A transaction hash submitted by a browser is not payment confirmation.

The dispatcher accepts work under the agreed terms; it cannot invent credits or choose rewards. Treasury signing stays outside the browser, agents and reconciliation worker. Supported routes and fees are shown in the quote.

## Learn from recent incidents

A separate public feed explains security incidents from the rolling last 72 hours, with sources, dates, corrections and uncertainty labels. Browse the terminal-style list with the keyboard or visible touch controls. Research is reviewed before publication and kept separate from private customer work.

## Repositories and architecture

| Repository | Responsibility | Source policy |
| --- | --- | --- |
| `patchriot-core` | Website, accounts, orders, NEAR Intents reconciliation, ledger and incident feed | Public target; AGPL-3.0-only |
| `patchriot-relay` | Rust application for pairing, isolated agent execution and result delivery | Public target; AGPL-3.0-only |
| `patchriot-dispatcher` | Work admission, operator approval, scheduling, review coordination and private artifacts | Private initially |

The dispatcher coordinates admission, screening and review policy. Its source is private during development; access checks and sandboxing remain the security boundaries.

```mermaid
flowchart LR
  U[Requester / patcher] --> W[Website]
  W --> C[Core Rust API]
  C <--> B[(Accounts, orders and ledger)]
  P[Core payment worker] <--> B
  P <--> N[NEAR Intents / 1Click]
  C -->|Authenticated API and durable events| D[Dispatcher]
  D <--> J[(Private jobs and artifacts)]
  R[Rust relay] -->|Outbound authenticated connection| D
  R --> S[Sandboxed agent and permitted tools]
  S --> M[Permitted inference endpoint]
```

Owned backend and relay components use Rust; the website uses React/TypeScript. Hermes and inference runtimes are external dependencies. Start with one Postgres installation, restricted database roles and private artifact storage. The relay enforces each assignment's filesystem, network and resource limits.

## Implementation plan and status

The relay now has a runnable owned-fixture demo: reproduce an access-control regression, check its fix and clean control, and exercise cancellation, deadlines and output bounds. It makes no model calls and has no customer-code sandbox yet. Website assessment, login, dispatch and payments remain planned. Each milestone adds tested behavior and reproducible setup instructions.

| Milestone | What completion means | Status |
| --- | --- | --- |
| Repository foundations | Three separate repositories, component boundaries, licenses and product documentation | Complete locally |
| Local process runner | Owned-code regression and clean control; cancellation, deadlines, output bounds and cleanup | Implemented in relay |
| Linux sandbox | Enforced filesystem/network/resource limits, host-canary and escape checks | Next |
| Hermes and CPU inference | A real agent run with measured resource use and reproducible output | Planned; VPS access needed |
| Pairing and dispatch | Short onboarding, manual approval, leases, retries and revocation | Planned |
| Review and verification | Investigator, reproducer and challenger roles with checked evidence and patch regressions | Planned |
| Accounts and private delivery | Google sign-in, stronger patcher/admin authentication and isolated reports/downloads | Planned |
| Website assessments | Owned-site fixtures, script/request inspection, DNS/TLS observations and scoped active checks | Planned |
| Recurring checks | Authorized schedules, approved baselines, private alerts, spending caps and missed-run handling | After one-off website reviews |
| NEAR Intents payments | Reconciliation and ledger tests, then a bounded live payment test | Planned |
| Website and incident feed | Review and patcher interfaces, sourced incident summaries and an end-to-end walkthrough | Planned |
| GPU demonstration | Three review roles on stronger models with measured results and honest operator/compute counts | After local and CPU checks |

The first test targets are owned fixtures. Run `cargo run --locked -- demo` inside `patchriot-relay`; its README explains the results and current execution boundary. Reproduction, patch behavior, account isolation, payment retries and sandbox boundaries need evidence before a capability is marked complete. Broader model support, optional contributor collateral and confidential execution are later decisions.

## License

Original material is [AGPL-3.0-only](LICENSE). See [NOTICE](NOTICE) for attribution. A future shared protocol crate will carry a separate Apache-2.0 license before use by the private service. Credentials, customer code and production data are excluded from source control.
