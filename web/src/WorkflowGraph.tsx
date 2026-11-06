import { useState } from 'react';
import { workflowStateLabels as statusText, workflowCaveat } from './workflow';
import { UIIcon } from './UIIcon';

/** View records are supplied only from the runner's typed checklist. */
export type WorkflowNodeStatus = 'pending' | 'running' | 'recorded' | 'reused' | 'incomplete' | 'not_applicable' | 'not_recorded';
export type WorkflowNode = {
  id: string;
  title: string;
  tool: string;
  description: string;
  status: WorkflowNodeStatus;
  detail?: string;
  evidence_count?: number;
  source_role?: string;
};
/** A fixed workflow graph with accessible node controls, never a simulated event feed. */
export function WorkflowGraph({ publicNodes, accessNodes, reportNode, recorded, live }: {
  publicNodes: WorkflowNode[]; accessNodes: WorkflowNode[]; reportNode: WorkflowNode; recorded: boolean; live: boolean;
}) {
  const nodes = [...publicNodes, ...accessNodes, reportNode];
  const [choice, setChoice] = useState<string | null>(null);
  const selected = nodes.find(node => node.id === choice) ?? nodes.find(node => node.status === 'running') ?? nodes.find(node => node.status === 'incomplete') ?? nodes[0];
  const label = (node: WorkflowNode) => node.status === 'running' && !live ? 'Last reported running' : statusText[node.status];
  function nodeButton(node: WorkflowNode, index: number, icon: 'shield' | 'globe' | 'agent' | 'lock' | 'file') {
    return <li key={node.id} data-status={node.status} data-live={live && node.status === 'running'} className="workflow-step">
      <button type="button" aria-pressed={selected.id === node.id} onClick={() => setChoice(node.id)} aria-label={`${node.title}: ${label(node)}`}>
        <span className="workflow-node"><UIIcon name={icon} /><span className="workflow-index">{String(index + 1).padStart(2, '0')}</span></span>
        <strong>{node.title}</strong><span className="workflow-tool">{node.tool}</span><span className="workflow-state">{label(node)}</span>
      </button>
    </li>;
  }
  return <div className="workflow-map" data-recorded={recorded}>
    <div className="workflow-intro"><div><span className="assessment-kicker">ONE PUBLIC BASELINE</span><h4>Public first. Deeper with access.</h4><p>Select a step to inspect its record.</p></div><span className="workflow-legend"><i aria-hidden="true" />{recorded ? 'Runner checklist' : 'Workflow guide'}</span></div>
    {!recorded && <p className="workflow-history" role="status">Structured checklist not recorded for this role. The map shows the planned workflow; tool records below remain available.</p>}
    <div className="workflow-lane workflow-public"><div className="workflow-lane-label"><span>01</span><strong>Public checks</strong><small>Shared by black-box and grey-box tests</small></div><ol aria-label="Public assessment workflow">{publicNodes.map((node,index) => nodeButton(node,index,index === 0 ? 'shield' : index === 1 ? 'globe' : 'agent'))}</ol></div>
    <div className="workflow-join" aria-hidden="true"><svg viewBox="0 0 1000 34" preserveAspectRatio="none"><path d={accessNodes.length ? 'M900 0V12H175V34M900 12H835V34' : 'M900 0V12H800V34'} /></svg></div>
    <div className="workflow-lower" data-authenticated={accessNodes.length > 0}>
      {accessNodes.length > 0 ? <div className="workflow-lane workflow-access"><div className="workflow-lane-label"><span>+</span><strong>Behind the login</strong><small>Additional grey-box checks</small></div><ol aria-label="Additional authenticated workflow">{accessNodes.map((node,index) => nodeButton(node,index + publicNodes.length,'lock'))}</ol></div> : <div className="workflow-public-only"><UIIcon name="shield" /><p><strong>Public scope</strong>Black-box checks continue to evidence review.</p></div>}
      <div className="workflow-lane workflow-output"><div className="workflow-lane-label"><span>→</span><strong>Evidence review</strong><small>Keep findings and gaps visible</small></div><ol aria-label="Report workflow">{nodeButton(reportNode,publicNodes.length + accessNodes.length,'file')}</ol></div>
    </div>
    <section className="workflow-inspector" aria-label="Selected workflow step">
      <div><span className="assessment-kicker">STEP DETAILS</span><h5>{selected.title}</h5><p>{selected.description}</p></div>
      <div className="workflow-inspector-state" data-status={selected.status}><strong>{label(selected)}</strong><p>{selected.detail ?? (selected.status === 'not_recorded' ? 'No structured execution record was retained. A report or heartbeat does not establish that this step finished.' : 'Select the recorded evidence in the report to inspect what the target returned.')}</p></div>
      {(selected.evidence_count !== undefined || selected.source_role) && <dl><div><dt>Evidence records</dt><dd>{selected.evidence_count ?? '—'}</dd></div>{selected.source_role && <div><dt>Evidence source</dt><dd>{selected.source_role}</dd></div>}</dl>}
    </section>
    <p className="workflow-footnote">{workflowCaveat}</p>
  </div>;
}
