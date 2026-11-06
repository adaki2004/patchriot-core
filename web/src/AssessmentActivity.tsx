import { useEffect, useState } from 'react';
import type { LiveRole, LiveStep } from './LiveReport';

const roles = { investigator: 'Scout', reproducer: 'Recon', challenger: 'Verifier' };
const stages = [
  { id: 'starting', title: 'Preparation', detail: 'Start the isolated runner' },
  { id: 'scoped_tools', title: 'Scoped checks', detail: 'Run permitted discovery tools' },
  { id: 'investigating', title: 'Investigation', detail: 'Explore leads and controls' },
  { id: 'finishing', title: 'Report', detail: 'Prepare findings and evidence' },
];

/** Uses only accepted progress snapshots and retained result records; no estimated coverage. */
export function AssessmentActivity({ steps, state }: { steps: LiveStep[]; state: string }) {
  const [choice, setChoice] = useState<LiveRole | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const selected = steps.find(s => s.role === choice) ?? steps.find(s => ['leased', 'running'].includes(s.state)) ?? steps[0];
  if (!selected) return null;
  const progress = selected.progress;
  const counts = selected.result?.execution ?? progress?.progress;
  const running = state === 'running' && ['leased', 'running'].includes(selected.state) && !selected.result;
  const stale = !!progress && now - progress.received_at * 1000 > 90_000;
  const tools = selected.result?.tool_runs ?? [];
  return <section className="assessment-activity" aria-label="Recorded assessment activity">
    <div className="activity-heading"><div><span className="assessment-kicker">RECORDED ACTIVITY</span><h3>Inside the assessment</h3></div><span className="activity-refresh">{running && progress ? stale ? 'Awaiting a fresh update' : 'Updates automatically' : selected.result ? 'Saved execution' : selected.state === 'failed' || state === 'failed' ? 'Execution stopped' : selected.state === 'cancelled' || state === 'cancelled' ? 'Execution cancelled' : state === 'awaiting_payment' ? 'Waiting for payment' : ['completed', 'needs_review'].includes(state) ? 'No execution record' : 'Waiting for an agent'}</span></div>
    <div className="activity-role-tabs" aria-label="Activity by agent">{steps.map(step => <button key={step.role} aria-pressed={selected.role === step.role} onClick={() => setChoice(step.role)}>{roles[step.role]}<span>{step.result ? step.evidence_complete ? 'Report received' : 'Needs review' : ['leased', 'running'].includes(step.state) ? 'Working' : step.state === 'failed' ? 'Stopped' : step.state === 'cancelled' ? 'Cancelled' : 'Waiting'}</span></button>)}</div>
    <ol className="activity-graph" aria-label="Assessment stages">{stages.map((stage, i) => <li key={stage.id} data-observed={!selected.result && progress?.progress.phase === stage.id} data-live={running && !stale && progress?.progress.phase === stage.id}><span className="activity-node" aria-hidden="true">{i + 1}</span><strong>{stage.title}</strong><small>{stage.detail}</small>{!selected.result && progress?.progress.phase === stage.id && <em>Last reported phase</em>}</li>)}</ol>
    <div className="activity-runtime"><dl><div><dt>HTTP requests</dt><dd>{counts?.http_requests ?? '—'}</dd></div><div><dt>Model calls</dt><dd>{counts?.inference_calls ?? '—'}</dd></div><div><dt>Tool runs</dt><dd>{selected.result ? tools.length : progress?.progress.completed_tools ?? '—'}</dd></div><div><dt>{selected.result ? 'Run duration' : 'Model wait'}</dt><dd>{selected.result ? `${Math.round(selected.result.execution.duration_ms / 1000)}s` : progress?.progress.model_request ? `${progress.progress.model_request.elapsed_seconds}s` : '—'}</dd></div></dl>
      <p>{progress ? <>Last received <time dateTime={new Date(progress.received_at * 1000).toISOString()}>{new Date(progress.received_at * 1000).toLocaleString()}</time>. </> : !selected.result ? 'No activity snapshot received yet. ' : ''}Snapshots show reported work, not a percentage of coverage.</p>
    </div>
    {tools.length > 0 ? <details className="activity-tools"><summary>Recorded tools · {tools.length}</summary><ul>{tools.map((tool, index) => <li key={`${tool.tool}-${index}`}><strong>{tool.tool}</strong><span>{tool.failure ? 'Incomplete' : tool.exit_code === 0 ? 'Finished' : 'Tool error'}</span><small>{Math.round(tool.duration_ms / 1000)}s · {tool.evidence_ids.length} request references</small></li>)}</ul></details> : <p className="activity-tool-note">{running ? 'Tool names and outcomes appear when the agent returns its evidence.' : 'No tool records received for this agent.'}</p>}
  </section>;
}
