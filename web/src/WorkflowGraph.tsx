import { useId, useLayoutEffect, useRef, useState } from 'react';
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
  measured_duration_ms?: number;
  source_role?: string;
};
type WorkflowEdge = { from: string; to: string; path: string };
type WorkflowDrawing = { width: number; height: number; edges: WorkflowEdge[] };

/** Keep consecutive steps connected when the graph changes between a row and a column. */
function useWorkflowEdges(key: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState<WorkflowDrawing>({ width: 0, height: 0, edges: [] });

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;

    const update = () => {
      const bounds = root.getBoundingClientRect();
      const nodes = [...root.querySelectorAll<HTMLElement>('.workflow-node')].map(node => {
        const rect = node.getBoundingClientRect();
        return {
          id: node.closest<HTMLElement>('[data-check]')!.dataset.check!,
          x: rect.left - bounds.left + rect.width / 2,
          y: rect.top - bounds.top + rect.height / 2,
          radius: rect.width / 2,
        };
      });
      const edges = nodes.slice(1).map((next, index) => {
        const previous = nodes[index];
        const horizontal = Math.abs(previous.y - next.y) < 2;
        const path = horizontal
          ? `M${previous.x + previous.radius} ${previous.y}L${next.x - next.radius} ${next.y}`
          : `M${previous.x} ${previous.y + previous.radius}L${next.x} ${next.y - next.radius}`;
        return { from: previous.id, to: next.id, path };
      });
      setDrawing({ width: bounds.width, height: bounds.height, edges });
    };

    const observer = new ResizeObserver(update);
    observer.observe(root);
    root.querySelectorAll('.workflow-node').forEach(node => observer.observe(node));
    window.addEventListener('resize', update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [key]);

  return { ref, drawing };
}

/** A fixed workflow graph with accessible node controls, never a simulated event feed. */
export function WorkflowGraph({ publicNodes, accessNodes, reportNode, coverageNode, recorded, live }: {
  publicNodes: WorkflowNode[]; accessNodes: WorkflowNode[]; reportNode: WorkflowNode; coverageNode?: WorkflowNode; recorded: boolean; live: boolean;
}) {
  const nodes = [...publicNodes, ...accessNodes, reportNode, ...(coverageNode ? [coverageNode] : [])];
  const marker=useId().replaceAll(':','');
  const {ref,drawing}=useWorkflowEdges(nodes.map(node=>node.id).join(','));
  const [choice, setChoice] = useState<string | null>(null);
  const selected = nodes.find(node => node.id === choice) ?? nodes.find(node => node.status === 'running') ?? nodes.find(node => node.status === 'incomplete') ?? nodes[0];
  const label = (node: WorkflowNode) => node.status === 'running' && !live ? 'Last reported running' : statusText[node.status];
  function nodeButton(node: WorkflowNode, index: number, icon: 'shield' | 'globe' | 'agent' | 'lock' | 'file') {
    return <li key={node.id} data-check={node.id} data-status={node.status} data-live={live && node.status === 'running'} className="workflow-step">
      <button type="button" aria-pressed={selected.id === node.id} onClick={() => setChoice(node.id)} aria-label={`${node.title}: ${label(node)}`}>
        <span className="workflow-node"><UIIcon name={icon} /><span className="workflow-index">{String(index + 1).padStart(2, '0')}</span></span>
        <strong>{node.title}</strong><span className="workflow-tool">{node.tool}</span><span className="workflow-state">{label(node)}</span>
      </button>
      {node.id === 'public_analysis' && coverageNode && <button type="button" className="workflow-coverage" aria-pressed={selected.id === coverageNode.id} onClick={() => setChoice(coverageNode.id)} aria-label={`${coverageNode.title}: ${label(coverageNode)}`}><span>Signed-in coverage</span><small>{label(coverageNode)} ↗</small></button>}
    </li>;
  }
  return <div className="workflow-map" data-recorded={recorded}>
    <div className="workflow-intro"><div><span className="assessment-kicker">ONE PUBLIC BASELINE</span><h4>{accessNodes.length ? 'Public and signed-in investigation.' : 'Public first. Deeper with access.'}</h4><p>{coverageNode ? 'Access is verified before one Agentic investigation. Open signed-in coverage for its request evidence and later agent checks.' : accessNodes.length ? 'Public investigation and signed-in checks follow the recorded workflow.' : 'Public checks lead into evidence review. Select a step for its evidence.'}</p></div><span className="workflow-legend"><i aria-hidden="true" />{recorded ? 'Runner checklist' : 'Workflow guide'}</span></div>
    {!recorded && <p className="workflow-history" role="status">Structured checklist not recorded for this role. The map shows the planned workflow; tool records below remain available.</p>}
    <div ref={ref} className="workflow-diagram" data-authenticated={accessNodes.length > 0} data-combined={!!coverageNode}>
      <svg className="workflow-edges" aria-hidden="true" width={drawing.width} height={drawing.height} viewBox={`0 0 ${drawing.width || 1} ${drawing.height || 1}`}><defs><marker id={marker} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M1 1L7 4L1 7" /></marker></defs>{drawing.edges.map(edge=><path key={edge.from} data-from={edge.from} data-to={edge.to} d={edge.path} markerEnd={`url(#${marker})`} />)}</svg>
      <div className="workflow-lane workflow-public">
        <div className="workflow-lane-label"><strong>{coverageNode ? 'Public baseline' : 'Public checks'}</strong><small>{coverageNode ? 'Four shared checks' : 'Shared public baseline'}</small></div>
        <ol aria-label="Public assessment workflow">{publicNodes.map((node, index) => nodeButton(node, index, index === 0 ? 'shield' : index === 1 ? 'globe' : 'agent'))}</ol>
      </div>
      {accessNodes.length > 0 && <div className="workflow-lane workflow-access">
        <div className="workflow-lane-label"><strong>{coverageNode ? 'Combined investigation' : 'Behind the login'}</strong><small>{coverageNode ? 'Verify access, then investigate' : 'Additional grey-box checks'}</small></div>
        <ol aria-label="Additional authenticated workflow">{accessNodes.map((node, index) => nodeButton(node, index + publicNodes.length, node.id === 'public_analysis' ? 'agent' : 'lock'))}</ol>
      </div>}
      <div className="workflow-lane workflow-output">
        <div className="workflow-lane-label"><strong>Evidence review</strong></div>
        <ol aria-label="Report workflow">{nodeButton(reportNode, publicNodes.length + accessNodes.length, 'file')}</ol>
      </div>
    </div>
    <p className="workflow-status-help"><strong>Recorded = finished work saved.</strong> These checks run once, often quickly; they are not continuous monitoring. Running marks the current step. Reused evidence comes from an earlier agent.</p>
    <section className="workflow-inspector" aria-label="Selected workflow step">
      <div><span className="assessment-kicker">STEP DETAILS</span><h5>{selected.title}</h5><p>{selected.description}</p></div>
      <div className="workflow-inspector-state" data-status={selected.status}><strong>{label(selected)}</strong><p>{selected.detail ?? (selected.status === 'not_recorded' ? 'No structured execution record was retained. A report or heartbeat does not establish that this step finished.' : 'Select the recorded evidence in the report to inspect what the target returned.')}</p></div>
      {(selected.evidence_count !== undefined || selected.source_role || selected.measured_duration_ms !== undefined) && <dl><div><dt>Evidence records</dt><dd>{selected.evidence_count ?? '—'}</dd></div>{selected.measured_duration_ms !== undefined && <div><dt>Recorded tool time</dt><dd>{Math.round(selected.measured_duration_ms / 1000)}s</dd></div>}{selected.source_role && <div><dt>Evidence source</dt><dd>{selected.source_role}</dd></div>}</dl>}
    </section>
    <p className="workflow-footnote">{workflowCaveat}</p>
  </div>;
}
