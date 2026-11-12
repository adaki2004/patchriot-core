import { useEffect, useRef, useState } from 'react';
import { checkDefinitions, toolCoverageDetail, workflowToolName, combinedEngineAccess } from './workflow';
import { WorkflowGraph } from './WorkflowGraph';
import { coverageSummary, toolOutcome } from './report';
import type { WorkflowNode } from './WorkflowGraph';
import type { LiveRole, LiveStep, LiveWorkflow, LiveToolRun, WorkflowCheckId } from './LiveReport';

const roles = { investigator: 'Scout', reproducer: 'Recon', challenger: 'Verifier' };
const stateDetails = {
  pending: 'No execution reported for this step yet.',
  running: 'The last accepted snapshot reports this step in progress.',
  recorded: 'The runner retained work or proof for this step. Inspect the evidence before accepting a finding.',
  incomplete: 'This step has an explicit coverage gap. The report’s limitations and tool evidence explain what remains unchecked.',
  reused: 'This step reuses a prior role’s retained evidence. It is not a fresh execution by the selected agent.',
  not_applicable: 'This step is not part of the saved testing scope.',
};
function workflowNodes(workflow: LiveWorkflow | undefined, tools: LiveToolRun[], combinedInvestigation: boolean, awaitingRecords: boolean): WorkflowNode[] {
  return checkDefinitions.filter(definition => definition.id !== 'public_deep' || (workflow?.version ?? 0) >= 2 || tools.some(tool => tool.tool === 'patchriot-deep')).map(definition => {
    const check = workflow && workflow.version >= 1 ? workflow.checks.find(check => check.id === definition.id) : undefined;
    const toolIds: Record<string, string> = {public_baseline:'patchriot-baseline',public_mapping:'patchriot-crawl',public_signatures:'nuclei',public_fingerprints:'ares-web-surface',public_analysis:tools.some(tool=>tool.tool==='patchriot-discovery')?'patchriot-discovery':'artex-engine',public_deep:'patchriot-deep'};
    const records = tools.filter(tool=>tool.tool===toolIds[definition.id] && !tool.arguments.includes('--discovery-suite'));
    const receiptDetail = check?.state === 'incomplete' ? records.map(toolCoverageDetail).find(Boolean) : undefined;
    const combined = records.map(combinedEngineAccess).find(Boolean);
    const presentation = definition.id === 'public_analysis' && combinedInvestigation ? {
      title: 'Web & API checks',
      tool: combined ? 'Anonymous + signed-in' : records.length ? 'Access coverage unverified' : 'Anonymous + signed-in',
      description: combined
        ? `This pass checked public and signed-in routes. Retained evidence includes ${combined.anonymous} anonymous and ${combined.authenticated} authenticated requests. The agent investigates leads from these results afterwards.`
        : 'Run structured web and API checks after verifying access, using public and signed-in requests. The agent investigates the resulting leads afterwards.',
    } : {};
    return { ...definition, ...presentation, measured_duration_ms:records.length ? records.reduce((total,tool)=>total+tool.duration_ms,0) : undefined, status: check?.state ?? (awaitingRecords ? 'pending' : 'not_recorded'), detail: receiptDetail ?? (check ? stateDetails[check.state] : awaitingRecords ? 'Waiting for this agent’s stage update. Earlier agents’ saved work remains in their own tabs.' : undefined), evidence_count: check?.evidence_count, source_role: check?.source_role ? roles[check.source_role] : undefined };
  });
}

function reportsCombinedInvestigation(step: LiveStep): boolean {
  const progress = step.progress?.progress;
  const state = (id: string) => progress?.workflow?.checks.find(check => check.id === id)?.state;
  return !step.result && progress?.phase === 'scoped_tools' && state('public_analysis') === 'running'
    && state('authentication') === 'recorded' && state('authenticated_checks') === 'running';
}

/** Supporting checks are populated from saved receipts, never inferred from a heartbeat. */
function supportingToolNodes(tools: LiveToolRun[]): WorkflowNode[] {
  const primaryTools = new Set(['patchriot-baseline', 'patchriot-crawl', 'nuclei', 'ares-web-surface', 'artex-engine', 'patchriot-discovery', 'patchriot-deep']);
  const descriptions: Record<string, string> = {
    'patchriot-probes': 'Compare HTTP controls using bounded requests and retained response evidence.',
    ffuf: 'Check candidate endpoints against missing-path controls. A matching response is a lead, not a confirmed vulnerability.',
    zap: 'Run scoped ZAP response checks and selected reflected-input checks. This is a bounded scanner profile, not every ZAP rule.',
    'patchriot-surface': 'Mine scripts and routes, then probe discovered paths against a missing-path control. A reachable route is a lead.',
    'patchriot-bypass': 'Compare case, separator and method variants against the original access-control result. A flipped status still needs review.',
    'patchriot-headers': 'Inject host and forwarding headers, then repeat the clean request to test caching. Reflection alone is not host-header injection.',
    'patchriot-inputs': 'Probe already-observed GET parameters against a baseline response. Reflection, a status change or a body change is a lead.',
    'patchriot-cross-account': 'Request the same objects with each supplied account and anonymously, then compare normalised bodies. Ownership needs a concrete field.',
    'zap-discoveries': 'Give ZAP new successful GET inputs recorded during the agentic investigation. Only approved origins and verified account contexts are eligible; missing inputs remain explicit.',
    schemathesis: 'Check an observed API schema when one is available. No schema means this check is not applicable.',
    'patchriot-coverage': 'Summarize retained checks and gaps. This is evidence accounting, not an additional target scan.',
  };
  const groups = new Map<string, LiveToolRun[]>();
  for (const tool of tools) {
    if (primaryTools.has(tool.tool) && !tool.arguments.includes('--discovery-suite')) continue;
    const key = tool.tool === 'zap' && tool.arguments.includes('--engine-discoveries') ? 'zap-discoveries' : tool.tool;
    groups.set(key, [...(groups.get(key) ?? []), tool]);
  }
  return [...groups].map(([key, records]) => {
    const outcomes = records.map(toolOutcome);
    const incomplete = outcomes.includes('Incomplete');
    const scannerDetail = records.map(toolCoverageDetail).filter(Boolean).join(' ');
    const stoppedScanner = incomplete && scannerDetail.includes('stopped early');
    const ran = outcomes.includes('Ran');
    const summaries = records.map(coverageSummary).filter(summary => summary !== undefined);
    const limits = [...new Set(summaries.flatMap(summary => summary.unverified))];
    const limited = limits.length > 0 || outcomes.includes('Limits recorded');
    const summaryDetail = summaries.length === records.length ? summaries.map(summary =>
      `Showing ${summary.shown} of ${summary.shown + summary.omitted} grouped entries. Each groups a URL, HTTP method and account context, or an unverified check; several HTTP requests can support one entry. ${summary.omitted ? `${summary.omitted} entries are outside this display; the request evidence is still saved. ` : ''}${summary.unverified.length ? `Coverage is not established for: ${summary.unverified.join(', ')}.` : ''}`).join(' ') : undefined;
    return { id: `tool-${key}`, parent_check: records.every(record=>record.arguments.includes('--deep-suite')) ? 'public_deep' : records.every(record=>record.arguments.includes('--discovery-suite')) ? 'public_analysis' : undefined, title: workflowToolName(records[0].tool, records[0]), tool: records[0].tool,
      description: descriptions[key] ?? 'Inspect the saved receipt for this supporting tool.',
      status: incomplete ? 'incomplete' : limited ? 'limited' : ran || summaries.length ? 'recorded' : 'not_applicable',
      state_label: stoppedScanner ? 'Stopped early' : incomplete ? 'Incomplete' : limits.length ? 'Limits recorded' : ran ? 'Recorded' : outcomes[0],
      detail: summaryDetail ?? (scannerDetail || undefined) ?? `${records.length} saved receipt${records.length === 1 ? '' : 's'}: ${outcomes.join(', ')}. ${incomplete ? 'A tool gap remains visible; inspect its receipt and the report’s limitations.' : 'Execution does not establish complete coverage or confirm a vulnerability.'}${records.some(record => record.output_truncated) ? 'Some retained tool output is shortened.' : ''}`,
      summary_counts: summaries.length === 1 && records.length === 1 ? {shown:summaries[0].shown,omitted:summaries[0].omitted} : undefined,
      measured_duration_ms: records.reduce((total, record) => total + record.duration_ms, 0),
      evidence_count: new Set(records.flatMap(record => record.evidence_ids)).size };
  });
}

/** Uses only accepted progress snapshots and retained result records; no estimated coverage. */
export function AssessmentActivity({ steps, state, authenticatedScope = false, pairedScope = false }: { steps: LiveStep[]; state: string; authenticatedScope?: boolean; pairedScope?: boolean }) {
  const [choice, setChoice] = useState<LiveRole | null>(null);
  const [now, setNow] = useState(Date.now);
  const observedCombined = useRef(new Set<LiveRole>());
  useEffect(() => {
    for (const step of steps) if (reportsCombinedInvestigation(step)) observedCombined.current.add(step.role);
  }, [steps]);
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
  // Current runners establish access before the web/API and deep passes.
  // Keep that layout from the first snapshot, rather than moving nodes mid-run.
  const combinedInvestigation = authenticatedScope && ((workflow?.version ?? 0) >= 2 || pairedScope || tools.some(tool => !!combinedEngineAccess(tool)) ||
    !selected.result && (reportsCombinedInvestigation(selected) || observedCombined.current.has(selected.role)));
  const awaitingRecords = !workflow && !selected.result && ['queued', 'leased', 'running'].includes(selected.state)
    && ['awaiting_payment', 'queued', 'running'].includes(state);
  const nodes = workflowNodes(workflow, tools, combinedInvestigation, awaitingRecords);
  // Resolve stages by id so an optional stage can never shift another one.
  const node = (id: WorkflowCheckId) => nodes.find(entry => entry.id === id)!;
  const browserState = progress?.progress.browser_exploration;
  // Browser activity has its own receipt-time signal. Counts and a finished
  // crawler cannot prove it ran. Older saved reports retain that uncertainty.
  const browserNode: WorkflowNode | undefined = !authenticatedScope && (browserState ||
    (workflow?.version ?? 0) >= 2 && node('public_analysis').status !== 'not_applicable') ? {
      id: 'browser_exploration', title: 'Explore in browser', tool: 'Agent · pages & controls',
      description: 'The agent opens pages and visible controls to discover routes and browser requests. This black-box preparation pass feeds Web & API checks; it is separate from the later vulnerability investigation.',
      status: browserState === 'running' ? 'running' : browserState === 'returned' ? 'recorded'
        : node('public_analysis').status === 'reused' ? 'not_applicable'
        : !selected.result && node('public_analysis').status === 'pending' ? 'pending' : 'not_recorded',
      state_label: browserState === 'returned' ? 'Step ended' : !browserState && node('public_analysis').status === 'reused' ? 'Not repeated' : undefined,
      detail: browserState === 'running' ? 'The browser agent is exploring the interface now. Web & API checks follow when this pass returns.'
        : browserState === 'returned' ? 'The browser pass returned. This records an activity transition, not proof that every page was explored or that any vulnerability was confirmed.'
        : node('public_analysis').status === 'reused' ? 'This role reuses earlier Web & API evidence rather than starting a fresh browser preparation pass. Its own vulnerability checks happen in Investigate & report.'
        : 'No separate browser activity has been reported. Do not infer browser coverage from crawl results or model-call counts.',
    } : undefined;
  nodes[nodes.indexOf(node('evidence_review'))] = { ...node('evidence_review'), tool: `${roles[selected.role]} · follow-up checks`,
    description: selected.role === 'investigator'
      ? 'Scout uses the collected evidence to identify possible vulnerabilities, runs focused checks and negative controls, then writes findings and limitations. This is where the agent actively searches for weaknesses beyond the structured scans.'
      : `${roles[selected.role]} checks the earlier findings against fresh controls and investigates promising untested leads. It then records supported findings, disagreements and limitations. A clean result is valid; it does not need to invent a finding.` };
  // Older runners leave this checklist entry pending until the result event.
  // Their accepted phase already identifies follow-up evidence investigation.
  // Never apply this compatibility mapping to queued roles or saved reports.
  if (running && node('evidence_review').status === 'pending' &&
      ['investigating', 'finishing'].includes(progress?.progress.phase ?? '')) {
    nodes[nodes.indexOf(node('evidence_review'))] = { ...node('evidence_review'), status: 'running' };
  }
  if (running && node('evidence_review').status === 'running') {
    nodes[nodes.indexOf(node('evidence_review'))] = { ...node('evidence_review'), detail: progress?.progress.phase === 'finishing'
      ? 'The agent is preparing and returning its report.'
      : 'The agent is checking leads against evidence and may make follow-up requests before writing its report. This is work by the selected agent; another agent’s queue is shown in the tabs above.' };
  }
  const coverage = combinedInvestigation ? { ...node('authenticated_checks'), title: 'Signed-in coverage', description: 'Signed-in request evidence from structured checks and any later agent investigation. Recorded means requests were retained with verified access. Inspect the evidence to see which resources and controls were checked.' } : undefined;
  const publicNodes = nodes.filter(entry => ['public_baseline','public_mapping','public_signatures','public_fingerprints','public_analysis','public_deep'].includes(entry.id) && !(combinedInvestigation && ['public_analysis','public_deep'].includes(entry.id)) && !(entry.id === 'public_deep' && entry.status === 'not_applicable'));
  if (browserNode) publicNodes.splice(publicNodes.findIndex(entry => entry.id === 'public_analysis'), 0, browserNode);
  return <section className="assessment-activity" aria-label="Recorded assessment activity">
    <div className="activity-heading"><div><span className="assessment-kicker">RECORDED ACTIVITY</span><h3>Inside the assessment</h3></div><span className="activity-refresh">{running && progress ? stale ? 'Awaiting a fresh update' : 'Updates automatically' : selected.result ? 'Saved execution' : selected.state === 'failed' || state === 'failed' ? 'Execution stopped' : selected.state === 'cancelled' || state === 'cancelled' ? 'Execution cancelled' : state === 'awaiting_payment' ? 'Waiting for payment' : ['completed', 'needs_review'].includes(state) ? 'No execution record' : 'Waiting for an agent'}</span></div>
    <div className="activity-role-tabs" aria-label="Activity by agent">{steps.map(step => <button key={step.role} aria-pressed={selected.role === step.role} onClick={() => setChoice(step.role)}>{roles[step.role]}<span>{step.result ? step.evidence_complete ? 'Report received' : 'Needs review' : ['leased', 'running'].includes(step.state) ? 'Working' : step.state === 'failed' ? 'Stopped' : step.state === 'cancelled' ? 'Cancelled' : 'Waiting'}</span></button>)}</div>
    <WorkflowGraph key={selected.role} publicNodes={publicNodes} accessNodes={combinedInvestigation ? [node('authentication'), node('public_analysis'), ...nodes.filter(entry => entry.id === 'public_deep' && entry.status !== 'not_applicable')] : authenticatedScope ? [node('authentication'), node('authenticated_checks')] : []} coverageNode={coverage} toolNodes={supportingToolNodes(tools)} reportNode={node('evidence_review')} recorded={(workflow?.version ?? 0) >= 1} awaitingRecords={awaitingRecords} live={running && !stale} />
    <div className="activity-runtime"><dl><div><dt>HTTP requests</dt><dd>{counts?.http_requests ?? '—'}</dd></div><div><dt>Model calls</dt><dd>{counts?.inference_calls ?? '—'}</dd></div><div><dt>Tool runs</dt><dd>{selected.result ? tools.length : progress?.progress.completed_tools ?? '—'}</dd></div><div><dt>{selected.result ? 'Run duration' : 'Model wait'}</dt><dd>{selected.result ? `${Math.round(selected.result.execution.duration_ms / 1000)}s` : progress?.progress.model_request ? `${progress.progress.model_request.elapsed_seconds}s` : '—'}</dd></div></dl>
      <p>{progress ? <>Last received <time dateTime={new Date(progress.received_at * 1000).toISOString()}>{new Date(progress.received_at * 1000).toLocaleString()}</time>. </> : !selected.result ? 'No activity snapshot received yet. ' : ''}Snapshots show reported work, not a percentage of coverage.</p>
    </div>
    {tools.length > 0 ? <details className="activity-tools"><summary>Recorded tools · {tools.length}</summary><ul>{tools.map((tool, index) => <li key={`${tool.tool}-${index}`}><strong>{workflowToolName(tool.tool, tool)}</strong><span>{toolCoverageDetail(tool) ? 'Incomplete' : toolOutcome(tool)}</span><small>{tool.tool} · {tool.version} · {Math.round(tool.duration_ms / 1000)}s · {tool.evidence_ids.length} request references</small>{toolCoverageDetail(tool) && <small className="activity-tool-reason">{toolCoverageDetail(tool)}</small>}</li>)}</ul></details> : <p className="activity-tool-note">{running ? 'Full tool transcripts appear when the agent returns its evidence.' : 'No tool records received for this agent.'}</p>}
  </section>;
}
