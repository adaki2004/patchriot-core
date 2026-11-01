import { useState } from 'react';
import { useLive } from './useLive';

type PairingInfo = { relay_origin: string; audience: string };
type Agent = { id: string; reported_os: string | null; runtime: string; runtime_version: string; declared_model: string | null; state: string; last_seen_at: number | null };

// Configuration is displayed as shell input, so quote even trusted server values.
function shell(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }

export function Guide({ onPair }: { onPair: () => void }) {
  const info = useLive<PairingInfo>('/pairing-info');
  const [agent, setAgent] = useState(false);
  const relay = './patchriot-relay';
  const state = agent ? '~/.patchriot-agent' : '~/.patchriot-fixture';
  const connect = `${relay} connect --state-dir ${state}${agent ? ' \\\n  --agents --agent-config .local/agent.json' : ' --fixtures'}`;
  return <section className="guide panel" aria-labelledby="setup-title">
    <p className="eyebrow">PAIR AGENT</p><h2 id="setup-title">Connect a machine you control.</h2>
    <p>Review the <a href="https://github.com/adaki2004/patchriot-relay#readme" target="_blank" rel="noreferrer">relay source and permissions ↗</a> yourself, or ask your security agent to check them before installing. We recommend a separate VPS. Pairing requires this approved account; an administrator must then approve the device.</p>
    <fieldset className="review-mode"><legend>What will this relay run?</legend>
      <label><input type="radio" name="setup-mode" checked={!agent} onChange={() => setAgent(false)} /><span><strong>Quick fixture check</strong><small>Built-in tests. No model or Docker needed.</small></span></label>
      <label><input type="radio" name="setup-mode" checked={agent} onChange={() => setAgent(true)} /><span><strong>Local agent with Hermes</strong><small>Your model and a pinned, isolated runtime.</small></span></label>
    </fieldset>
    {info.error && <div className="notice error" role="alert">{info.error} <button className="inline" onClick={info.refresh}>Retry</button></div>}
    {!info.data && !info.error && <p role="status">Loading this deployment’s connection details…</p>}
    <ol className="steps">
      <li><strong>Download and check.</strong><span>Get the Linux x86-64 binary and matching checksums from <a href="https://github.com/adaki2004/patchriot-relay/releases" target="_blank" rel="noreferrer">Releases ↗</a>. Follow the README to verify and unpack it. On other systems, build from source.</span>{agent && <span>Follow the relay README to prepare the isolated agent and save its pinned settings in <code>.local/agent.json</code>. Keep keys and private settings outside Git.</span>}<pre>{agent ? `${relay} agent-check --config .local/agent.json` : `${relay} demo`}</pre><span>This checks a supplied example and cleanup, not the agent’s security expertise.</span></li>
      <li><strong>Create a device identity.</strong><span>These connection details belong to this installation. Use a separate state directory for each device and the same compute group for devices sharing a machine. Model and OS information will be visible to other admitted users; keep private information out of those fields.</span>{info.data && !info.error && <pre>{`${relay} init --state-dir ${state} \\\n  --dispatcher ${shell(info.data.relay_origin)} \\\n  --audience ${shell(info.data.audience)} \\\n  --label ${agent ? 'my-agent' : 'my-fixture'} --compute-group my-machine${agent ? ' \\\n  --runtime hermes --runtime-version YOUR-HERMES-VERSION \\\n  --model YOUR-LOCAL-MODEL' : ''}`}</pre>}</li>
      <li><strong>Claim the code, then connect.</strong><span>Run <code>pair</code>, enter its five-minute code here and complete the short operator profile. The administrator checks the device before it can take work.</span><pre>{`${relay} pair --state-dir ${state}\n${connect}`}</pre><button className="primary" onClick={onPair}>Enter pairing code →</button></li>
      <li><strong>Keep it running.</strong><span>Use the same Unix account for setup and the service. The README includes systemd units for a Linux VPS. Preserve the private state directory when upgrading; it holds the device key. Stop or pause whenever needed.</span><pre>{`${relay} status --state-dir ${state}\n${relay} pause --state-dir ${state}\n${relay} resume --state-dir ${state}`}</pre></li>
    </ol>
    <p className="fine">A review uses three approved devices. Shared machines run one role at a time. Three devices on one VPS are still one shared machine.</p>
    {agent && <details className="execution-details"><summary>Opt in to private website reviews</summary><p>After testing, restart with <code>--website-reviews</code>. An admin must separately allow private reviews, and a requester must confirm the proposed team before sharing a saved snapshot. You can see that plaintext.</p><pre>{`${connect} --website-reviews`}</pre></details>}
  </section>;
}

export function AgentList() {
  const agents = useLive<Agent[]>('/agents');
  return <section className="panel agent-panel" aria-labelledby="agents-title">
    <div className="panel-heading"><div><p className="eyebrow">AGENTS</p><h2 id="agents-title">Connected to Patchriot</h2></div><button className="quiet" onClick={agents.refresh}>Refresh</button></div>
    <p>Approved devices, with OS, harness and model information reported by their operators. A heartbeat shows presence, not availability or verified skill.</p>
    {agents.error && <div className="notice error" role="alert">{agents.error}</div>}
    {!agents.data && !agents.error && <p role="status">Loading agents…</p>}
    {agents.data?.length === 0 && <p>No approved agents to show yet.</p>}
    <div className="agent-directory">{agents.data?.map(agent => <article key={agent.id} className="agent-entry">
      <div><strong>{agent.runtime === 'hermes' ? 'Hermes' : 'Built-in example'} <span className="subtle">{agent.runtime_version}</span></strong><span className="pill">{agent.state.replaceAll('_', ' ')}</span></div>
      <dl><dt>System</dt><dd>{agent.reported_os ?? 'Not reported'}</dd><dt>Model</dt><dd>{agent.declared_model ?? 'No model'}</dd><dt>Last heartbeat</dt><dd>{agent.last_seen_at ? new Date(agent.last_seen_at * 1000).toLocaleString() : 'None yet'}</dd></dl>
      <small className="subtle">Device {agent.id.slice(0, 8)}</small>
    </article>)}</div>
    <p className="fine">This list contains no customer targets, reports, operator profiles or machine addresses.</p>
  </section>;
}
