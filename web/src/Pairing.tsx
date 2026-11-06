import { useState } from 'react';
import { useLive } from './useLive';
import type { AgentSystem } from './api';

type PairingInfo = { relay_origin: string; audience: string };
type Agent = { id: string; reported_os: string | null; system?: AgentSystem | null; runtime: string; runtime_version: string; declared_model: string | null; state: string; last_seen_at: number | null; live_tests?: boolean; live_tools?: string[]; reports_received?: number };
const repository = 'https://github.com/adaki2004/patchriot-relay';
// Configuration is displayed as shell input, so quote even trusted server values.
function shell(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
function localAddress(value: string) {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname); } catch { return false; }
}
function Command({ children }: { children: string }) {
  const [notice, setNotice] = useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(children); setNotice('Copied'); }
    catch { setNotice('Select the command and copy it manually.'); }
  }
  return <div className="pair-command"><pre>{children}</pre><div><button className="quiet" onClick={() => void copy()}>Copy command</button>{notice && <span role="status">{notice}</span>}</div></div>;
}

export function PairingClosed({ earnings = false }: { earnings?: boolean }) {
  return <section className="panel contributor-preview"><p className="eyebrow">CONTRIBUTORS · COMING SOON</p><h1 className="page-title">{earnings ? 'Earnings are coming soon.' : 'Bring your agents. Soon.'}</h1><p>{earnings ? 'Earnings will become available when users can provide inference. There are no contributor earnings to display yet.' : 'Users can’t yet provide inference. We run the testing agents while we prepare contributor access.'}</p><p>You can already request a security assessment and follow its progress in Audits.</p></section>;
}

export function Guide({ onPair }: { onPair: () => void }) {
  const info = useLive<PairingInfo>('/pairing-info', true, 60_000);
  const [agent, setAgent] = useState(false);
  const [step, setStep] = useState(0);
  const state = agent ? '~/.patchriot-agent' : '~/.patchriot-fixture';
  const connect = `./patchriot-relay connect --state-dir ${state}${agent ? ' \\\n  --agents --agent-config .local/agent.json' : ' --fixtures'}`;
  const available = info.data && !info.error;
  const loopback = available && localAddress(info.data!.relay_origin);
  const mesh = available && (() => { try { const url = new URL(info.data!.relay_origin); return url.protocol === 'https:' && url.hostname.endsWith('.ts.net'); } catch { return false; } })();
  const steps = ['Your machine', 'Install the relay', 'Connect', 'Get approved', 'Keep it online'];
  return <section className="pair-guide" aria-labelledby="setup-title">
    <div className="dashboard-title"><div><p className="eyebrow">STAFF ONLY / MANAGED AGENTS</p><h1 id="setup-title">Pair through your approved account.</h1><p className="subtle">Connect a machine you administer. Managed agents use Hermes on Kali with an approved model provider.</p></div></div>
    {loopback && <aside className="pair-production-note"><strong>Local pilot address.</strong> Before public deployment, configure a distinct, reachable HTTPS relay address. Remote contributors must never be given localhost or 127.0.0.1. <a href="#/docs/deployment">Deployment checklist ↗</a></aside>}
    <nav className="pair-steps" aria-label="Pairing steps">{steps.map((name, index) => <button key={name} aria-current={step === index ? 'step' : undefined} onClick={() => setStep(index)}><span>{index + 1}</span>{name}</button>)}</nav>
    {info.error && <div className="notice error" role="alert">{info.error} <button className="inline" onClick={info.refresh}>Retry</button></div>}
    <div className="pair-step-content">
      {step === 0 && <>
        <span className="eyebrow">01 / PREPARE</span><h2>Use a separate machine.</h2><p>A Linux VPS is a good place to start. Keep personal files and production credentials off it.</p>
        <fieldset className="pair-modes"><legend>What would you like to connect?</legend><label><input type="radio" name="setup-mode" checked={!agent} onChange={() => setAgent(false)} /><span><strong>Try the connection first</strong><small>A built-in example. No model, GPU or Docker required.</small></span></label><label><input type="radio" name="setup-mode" checked={agent} onChange={() => setAgent(true)} /><span><strong>Local agent with Hermes</strong><small>A Linux host, Docker and your own local model.</small></span></label></fieldset>
        <div className="pair-hardware"><article><h3>CPU VPS</h3><p>Enough for pairing and the supplied example. Local model reviews can be slow.</p></article><article><h3>GPU machine</h3><p>For faster local inference. Choose RAM and VRAM to fit the model you install.</p></article></div>
        <p className="fine">This walkthrough starts with an offline connection check. For hosted web tests, follow the relay README’s hosted-provider setup. Model and backup settings must match the approved request. Keep the provider key outside the task container. A key alone does not pair or approve an agent.</p>
        <details><summary>What does the relay do?</summary><p>It keeps a device identity, receives scoped assignments, starts isolated work and returns the result. You can pause it locally. Approved operators can read assigned material; model declarations are not proof of honesty or skill.</p></details>
      </>}
      {step === 1 && <>
        <span className="eyebrow">02 / INSTALL</span><h2>Get the relay onto that machine.</h2><p><strong>DON’T TRUST. VERIFY.</strong> Read the <a href={`${repository}#readme`} target="_blank" rel="noreferrer">source and permissions ↗</a>, or ask your own agent to audit them before installing.</p>
        <ol className="pair-install"><li>Open <a href={`${repository}/releases`} target="_blank" rel="noreferrer">Releases ↗</a> and choose a version you reviewed.</li><li>Download <code>patchriot-relay-linux-x86_64.tar.gz</code> and <code>SHA256SUMS</code> from that same release into one folder on your Linux x86-64 machine.</li><li>In that folder, verify the archive. Only unpack if verification passes.</li></ol>
        <Command>{'sha256sum --check --ignore-missing SHA256SUMS &&\n  tar -xzf patchriot-relay-linux-x86_64.tar.gz &&\n  cd patchriot-relay &&\n  ./patchriot-relay --help'}</Command>
        <p className="fine"><code>./patchriot-relay</code> means the binary in your current folder. If no release is available, or you use another architecture, follow the README’s build instructions.</p>
        {agent && <aside className="pair-note"><h3>Prepare the local agent too.</h3><p>Use the <a href={`${repository}#what-the-safety-limits-mean`} target="_blank" rel="noreferrer">isolated runtime setup ↗</a> to install the supported model and pin its container. Save your private settings in <code>.local/agent.json</code>.</p><Command>{'./patchriot-relay agent-check --config .local/agent.json'}</Command></aside>}
      </>}
      {step === 2 && <>
        <span className="eyebrow">03 / CONNECT</span><h2>Create an identity. Get a code.</h2><p>The connection address below comes from this Patchriot installation. You do not need to invent a server address.</p>
        {!available && !info.error && <p role="status">Loading this deployment’s connection details…</p>}
        {available && <><div className="connection-address"><span>{loopback ? 'Local pilot connection' : mesh ? 'Private Tailscale connection' : 'Relay connection'}</span><code>{info.data!.relay_origin}</code></div>{loopback && <p className="notice">This is a local address. On a different VPS it only works with an administrator-configured tunnel. Ask the administrator for a reachable relay address before connecting a new remote machine.</p>}
        {mesh && <aside className="pair-note"><h3>Join the private network first.</h3><p>The administrator must admit this machine to the deployment’s Tailscale network. Then check the connection below. This does not approve your agent or grant access to other machines.</p><Command>{`tailscale status
./patchriot-relay mesh-check --dispatcher ${shell(info.data!.relay_origin)}`}</Command><p className="fine">The check reads gateway health only. If it fails, check Tailscale login, network grants and the gateway address. Never put a Tailscale auth key into the pairing form.</p></aside>}
        <Command>{`./patchriot-relay init --state-dir ${state} \\\n  --dispatcher ${shell(info.data!.relay_origin)} \\\n  --audience ${shell(info.data!.audience)} \\\n  --label ${agent ? 'my-agent' : 'my-fixture'} --compute-group my-machine${agent ? ' \\\n  --runtime hermes --runtime-version YOUR-HERMES-VERSION \\\n  --model YOUR-LOCAL-MODEL' : ''}\n./patchriot-relay pair --state-dir ${state}`}</Command></>}
        <p className="fine">Choose a label and replace the model/version placeholders with your actual setup. Use a separate state directory per device and the same compute group for devices on one machine.</p>
        <button className="primary" disabled={!available} onClick={onPair}>Enter pairing code →</button>
      </>}
      {step === 3 && <>
        <span className="eyebrow">04 / APPROVAL</span><h2>A short check before shared work.</h2><ol className="pair-install"><li>Enter the five-minute code and your operator details.</li><li>An admin checks the device. Pairing alone does not admit it to private work.</li><li>Run the connection command. Open <strong>My agents</strong> to see its heartbeat.</li></ol><Command>{connect}</Command>
        <p>Start with the supplied example under <strong>Audits → Saved material and test examples</strong>. It checks the connection and runner, not your agent’s security expertise.</p>
        <details><summary>Receiving private reviews</summary><p>After testing, opt in with <code>--website-reviews</code> and/or <code>--source-reviews</code>. Private work also requires separate admin approval and the requester’s consent to the proposed team. Three devices on the same VPS still count as one shared machine.</p></details>
      </>}
      {step === 4 && <>
        <span className="eyebrow">05 / RUN</span><h2>Stay online on your terms.</h2><p>On a Linux VPS, use the supplied systemd service so a closed terminal does not stop the relay. Follow the <a href={`${repository}#keep-a-relay-running`} target="_blank" rel="noreferrer">service setup ↗</a> after the example works.</p><Command>{`./patchriot-relay status --state-dir ${state}\n./patchriot-relay pause --state-dir ${state}\n./patchriot-relay resume --state-dir ${state}`}</Command><p className="fine">Run pairing and the service as the same Unix user. Preserve the private state directory on upgrades; it holds the device key.</p><div className="pair-note"><h3>Where earnings appear</h3><p>Completed paid work credits your account. See the dashboard’s earnings balance. Coupon work creates no cash earnings; an incomplete report needs review.</p></div>
      </>}
      <div className="pair-step-actions"><button className="quiet" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>← Back</button>{step < 4 && <button className="primary" onClick={() => setStep(step + 1)}>{steps[step + 1]} →</button>}</div>
    </div>
    <button className="text-button" onClick={onPair}>I already have a pairing code →</button>
  </section>;
}

export function AgentList({ compact = false, onAll }: { compact?: boolean; onAll?: () => void }) {
  const agents = useLive<Agent[]>('/agents');
  return <section className={compact ? 'agent-panel compact-agents' : 'panel agent-panel'} aria-labelledby="agents-title">
    <div className={compact ? 'block-heading' : 'panel-heading'}><div>{!compact && <p className="eyebrow">NETWORK</p>}<h2 id="agents-title">{compact ? 'Network agents' : 'Connected to Patchriot'}</h2></div>{compact ? <button className="text-button" onClick={onAll}>View all →</button> : <button className="quiet" onClick={agents.refresh}>Refresh</button>}</div>
    {!compact && <p>Approved agents across the network. Software and model details are self-reported.</p>}
    {agents.error && <div className="notice error" role="alert">{agents.error}</div>}
    {!agents.data && !agents.error && <p role="status">Loading agents…</p>}
    {agents.data?.length === 0 && <p>No approved agents to show yet.</p>}
    <div className="agent-directory">{(compact ? agents.data?.slice(0, 3) : agents.data)?.map(agent => <article key={agent.id} className="agent-entry">
      <div><strong>{agent.runtime === 'hermes' ? 'Hermes' : 'Built-in example'} <span className="subtle">{agent.id.slice(0, 8)}</span></strong><span className="pill">{agent.state.replaceAll('_', ' ')}</span></div>
      <dl><dt>System</dt><dd>{agent.system ? [agent.system.os_name, agent.system.os_version].filter(Boolean).join(' ') : agent.reported_os ?? 'Not reported'}</dd><dt>Model</dt><dd>{agent.declared_model ?? 'No model'}</dd>{compact && <><dt>Runtime</dt><dd>{agent.runtime_version || 'Not reported'}</dd><dt>Heartbeat</dt><dd>{agent.last_seen_at ? <time dateTime={new Date(agent.last_seen_at * 1000).toISOString()}>{new Date(agent.last_seen_at * 1000).toLocaleTimeString()}</time> : 'None yet'}</dd><dt>Reports</dt><dd>{agent.reports_received == null ? '—' : agent.reports_received.toLocaleString()}</dd></>}{!compact && <>
        <dt>Runner version</dt><dd>{agent.runtime_version}</dd>
        {agent.system && <><dt>Architecture</dt><dd>{agent.system.architecture}</dd><dt>Relay version</dt><dd>{agent.system.relay_version}</dd></>}
        <dt>Website tests</dt><dd>{agent.live_tests ? (agent.live_tools?.includes('artex_engine_v1') ? 'ARTEX + standard checks' : 'Standard checks') : 'Not enabled'}</dd>
        {agent.live_tests && <><dt>Supported roles</dt><dd>Investigation, reproduction and evidence review. Assigned per assessment.</dd></>}<dt>Reports received</dt><dd>{agent.reports_received == null ? '—' : agent.reports_received.toLocaleString()}</dd>
        <dt>Last heartbeat</dt><dd>{agent.last_seen_at ? new Date(agent.last_seen_at * 1000).toLocaleString() : 'None yet'}</dd></>}</dl>
      {!compact && <small className="subtle">Device {agent.id.slice(0, 8)}</small>}
    </article>)}</div>
    <p className="fine">{compact ? 'Network-wide presence. Online does not mean available or independently verified.' : 'A heartbeat shows presence, not verified skill. Counts include incomplete role reports, not just confirmed findings. Customer work and machine addresses are private.'}</p>
  </section>;
}
