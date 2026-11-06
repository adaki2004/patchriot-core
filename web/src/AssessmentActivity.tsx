import { useEffect, useState } from 'react';
import { checkDefinitions } from './workflow';
import { WorkflowGraph } from './WorkflowGraph';
import type { WorkflowNode } from './WorkflowGraph';
import type { LiveRole, LiveStep, LiveWorkflow } from './LiveReport';

const roles = { investigator: 'Scout', reproducer: 'Recon', challenger: 'Verifier' };
const stateDetails = {
  pending: 'No execution reported for this step yet.',
  running: 'The last accepted snapshot reports this step in progress.',
  recorded: 'The runner retained work or proof for this step. Inspect the evidence before accepting a finding.',
  incomplete: 'This step has an explicit coverage gap. The report’s limitations and tool evidence explain what remains unchecked.',
  reused: 'This step reuses a prior role’s retained evidence. It is not a fresh execution by the selected agent.',
  not_applicable: 'This step is not part of the saved testing scope.',
};
function workflowNodes(workflow: LiveWorkflow | undefined): WorkflowNode[] {
  return checkDefinitions.map(definition => {
    const check = workflow?.version === 1 ? workflow.checks.find(check => check.id === definition.id) : undefined;
    return { ...definition, status: check?.state ?? 'not_recorded', detail: check ? stateDetails[check.state] : undefined, evidence_count: check?.evidence_count, source_role: check?.source_role ? roles[check.source_role] : undefined };
  });
}

/** Uses only accepted progress snapshots and retained result records; no estimated coverage. */
export function AssessmentActivity({ steps, state, authenticatedScope = false }: { steps: LiveStep[]; state: string; authenticatedScope?: boolean }) {
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
  const workflow = selected.result ? selected.result.workflow : progress?.progress.workflow;
  const nodes = workflowNodes(workflow);
  return <section className="assessment-activity" aria-label="Recorded assessment activity">
    <div className="activity-heading"><div><span className="assessment-kicker">RECORDED ACTIVITY</span><h3>Inside the assessment</h3></div><span className="activity-refresh">{running && progress ? stale ? 'Awaiting a fresh update' : 'Updates automatically' : selected.result ? 'Saved execution' : selected.state === 'failed' || state === 'failed' ? 'Execution stopped' : selected.state === 'cancelled' || state === 'cancelled' ? 'Execution cancelled' : state === 'awaiting_payment' ? 'Waiting for payment' : ['completed', 'needs_review'].includes(state) ? 'No execution record' : 'Waiting for an agent'}</span></div>
    <div className="activity-role-tabs" aria-label="Activity by agent">{steps.map(step => <button key={step.role} aria-pressed={selected.role === step.role} onClick={() => setChoice(step.role)}>{roles[step.role]}<span>{step.result ? step.evidence_complete ? 'Report received' : 'Needs review' : ['leased', 'running'].includes(step.state) ? 'Working' : step.state === 'failed' ? 'Stopped' : step.state === 'cancelled' ? 'Cancelled' : 'Waiting'}</span></button>)}</div>
    <WorkflowGraph key={selected.role} publicNodes={nodes.slice(0, 5)} accessNodes={authenticatedScope ? nodes.slice(5, 7) : []} reportNode={nodes[7]} recorded={workflow?.version === 1} live={running && !stale} />
    <div className="activity-runtime"><dl><div><dt>HTTP requests</dt><dd>{counts?.http_requests ?? '—'}</dd></div><div><dt>Model calls</dt><dd>{counts?.inference_calls ?? '—'}</dd></div><div><dt>Tool runs</dt><dd>{selected.result ? tools.length : progress?.progress.completed_tools ?? '—'}</dd></div><div><dt>{selected.result ? 'Run duration' : 'Model wait'}</dt><dd>{selected.result ? `${Math.round(selected.result.execution.duration_ms / 1000)}s` : progress?.progress.model_request ? `${progress.progress.model_request.elapsed_seconds}s` : '—'}</dd></div></dl>
      <p>{progress ? <>Last received <time dateTime={new Date(progress.received_at * 1000).toISOString()}>{new Date(progress.received_at * 1000).toLocaleString()}</time>. </> : !selected.result ? 'No activity snapshot received yet. ' : ''}Snapshots show reported work, not a percentage of coverage.</p>
    </div>
    {tools.length > 0 ? <details className="activity-tools"><summary>Recorded tools · {tools.length}</summary><ul>{tools.map((tool, index) => <li key={`${tool.tool}-${index}`}><strong>{tool.tool}</strong><span>{tool.failure ? 'Incomplete' : tool.exit_code === 0 ? 'Finished' : 'Tool error'}</span><small>{Math.round(tool.duration_ms / 1000)}s · {tool.evidence_ids.length} request references</small></li>)}</ul></details> : <p className="activity-tool-note">{running ? 'Full tool transcripts appear when the agent returns its evidence.' : 'No tool records received for this agent.'}</p>}
  </section>;
}
