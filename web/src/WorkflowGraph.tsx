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
  summary_counts?: {shown: number; omitted: number};
  state_label?: string;
};
type WorkflowEdge = { from: string; to: string; path: string };
type WorkflowBranch = { group: string; path: string; anchors: {x: number; y: number}[] };
type WorkflowDrawing = { width: number; height: number; edges: WorkflowEdge[]; branches: WorkflowBranch[] };

/** Keep consecutive steps connected when the graph changes between a row and a column. */
function useWorkflowEdges(key: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState<WorkflowDrawing>({ width: 0, height: 0, edges: [], branches: [] });

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
      const vertical = nodes.length > 1 && Math.abs(nodes[0].y - nodes[1].y) > 2;
      const branches = [...root.querySelectorAll<HTMLElement>('[data-parents]')].flatMap(cluster => {
        const parents = (cluster.dataset.parents ?? '').split(' ').map(id => nodes.find(node => node.id === id)).filter(node => node !== undefined);
        if (!parents.length) return [];
        const heading = cluster.querySelector('.workflow-cluster-root')!.getBoundingClientRect();
        const target = {x: heading.left - bounds.left + heading.width / 2, y: heading.top - bounds.top};
        if (vertical) {
          // The mobile shelf branches from its last related step on the continuous main spine.
          const parent = parents[parents.length - 1];
          const y = heading.top - bounds.top + heading.height / 2;
          const end = heading.left - bounds.left;
          return [{group: cluster.dataset.cluster!, path: `M${parent.x} ${parent.y + parent.radius}V${y}H${end}`, anchors: [{x: parent.x, y: y}]}];
        }
        const anchors = parents.map(parent => {
          const step = [...root.querySelectorAll<HTMLElement>('[data-check]')].find(el => el.dataset.check === parent.id)!;
          const content = step.querySelector('.workflow-coverage') ?? step.querySelector('.workflow-state') ?? step;
          const rect = content.getBoundingClientRect();
          return {x: parent.x, y: rect.bottom - bounds.top + 8};
        });
        const rail = target.y - 12;
        const drops = anchors.map(point => `M${point.x} ${point.y}V${rail}`).join('');
        const path = parents.length === 1
          ? `M${anchors[0].x} ${anchors[0].y}V${rail}H${target.x}V${target.y}`
          : `${drops}M${anchors[0].x} ${rail}H${anchors[anchors.length - 1].x}M${target.x} ${rail}V${target.y}`;
        return [{group: cluster.dataset.cluster!, path, anchors}];
      });
      setDrawing({ width: bounds.width, height: bounds.height, edges, branches });
    };

    const observer = new ResizeObserver(update);
    observer.observe(root);
    root.querySelectorAll('.workflow-node, .workflow-step, .workflow-tool-cluster').forEach(node => observer.observe(node));
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
export function WorkflowGraph({ publicNodes, accessNodes, reportNode, coverageNode, toolNodes = [], recorded, live }: {
  publicNodes: WorkflowNode[]; accessNodes: WorkflowNode[]; reportNode: WorkflowNode; coverageNode?: WorkflowNode; toolNodes?: WorkflowNode[]; recorded: boolean; live: boolean;
}) {
  const nodes = [...publicNodes, ...accessNodes, reportNode, ...(coverageNode ? [coverageNode] : []), ...toolNodes];
  const marker=useId().replaceAll(':','');
  const {ref,drawing}=useWorkflowEdges(nodes.map(node=>node.id).join(','));
  const inspector = useRef<HTMLElement>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);
  const selected = nodes.find(node => node.id === choice) ?? nodes.find(node => node.status === 'running') ?? nodes.find(node => node.status === 'incomplete') ?? nodes[0];
  const label = (node: WorkflowNode) => node.state_label ?? (node.status === 'running' && !live ? 'Last reported running' : statusText[node.status]);
  const route = [...publicNodes, ...accessNodes, reportNode];
  const investigationIndex = route.findIndex(node => node.id === 'public_analysis');
  const scopedTools = toolNodes.filter(node => !['tool-zap-discoveries', 'tool-patchriot-coverage'].includes(node.id));
  const baselineIds = route.slice(0, investigationIndex > 0 ? investigationIndex : 4).map(node => node.id);
  const parentIds: Record<string, string[]> = {baseline: baselineIds, 'follow-up': ['public_analysis'], coverage: [reportNode.id]};
  const groupFor = (id: string) => id === 'tool-zap-discoveries' ? 'follow-up' : id === 'tool-patchriot-coverage' ? 'coverage' : scopedTools.some(node => node.id === id) ? 'baseline' : null;
  const activeGroup = hoveredGroup ?? groupFor(selected.id);
  const related = (id: string) => !!activeGroup && parentIds[activeGroup].includes(id);
  function inspectTool(id: string) {
    setChoice(id);
    if ((ref.current?.clientWidth ?? Infinity) <= 760) requestAnimationFrame(() => {
      inspector.current?.scrollIntoView({block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    });
  }
  function toolCluster(title: string, records: WorkflowNode[], column: string, order: number, kind: string) {
    if (!records.length) return null;
    return <section className="workflow-tool-cluster" data-cluster={kind} data-parents={parentIds[kind].join(' ')} data-related={activeGroup === kind} onPointerEnter={() => setHoveredGroup(kind)} onPointerLeave={() => setHoveredGroup(null)} onFocus={() => setHoveredGroup(kind)} onBlur={() => setHoveredGroup(null)} aria-label={title} style={{gridColumn: column, order}}>
      <div className="workflow-tool-tree"><h5><span className="workflow-cluster-root" aria-hidden="true" />{title}</h5><ul>{records.map(node => <li key={node.id} data-tool-check={node.id} data-status={node.status}>
        <button type="button" aria-pressed={selected.id === node.id} onClick={() => inspectTool(node.id)} aria-label={`${node.title}: ${label(node)}`}>
          <span className="tool-record-mark" aria-hidden="true">{node.status === 'incomplete' ? '!' : node.status === 'not_applicable' ? '–' : '✓'}</span>
          <span className="tool-record-name">{node.id === 'tool-zap-discoveries' ? 'ZAP follow-up' : node.title}<small>{label(node)}</small></span><span className="tool-record-open" aria-hidden="true">›</span>
        </button>
      </li>)}</ul></div>
    </section>;
  }
  function nodeButton(node: WorkflowNode, index: number, icon: 'shield' | 'globe' | 'agent' | 'lock' | 'file') {
    return <li key={node.id} data-check={node.id} data-related={related(node.id)} data-status={node.status} data-live={live && node.status === 'running'} className="workflow-step" style={{order: (index + 1) * 10}}>
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
      <svg className="workflow-edges" aria-hidden="true" width={drawing.width} height={drawing.height} viewBox={`0 0 ${drawing.width || 1} ${drawing.height || 1}`}><defs><marker id={marker} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M1 1L7 4L1 7" /></marker></defs>{drawing.edges.map(edge=><path key={edge.from} data-from={edge.from} data-to={edge.to} d={edge.path} markerEnd={`url(#${marker})`} />)}<g className="workflow-evidence-edges">{drawing.branches.map(branch => <g key={branch.group} data-branch={branch.group} data-related={activeGroup === branch.group}><path d={branch.path} />{branch.anchors.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="2.5" />)}</g>)}</g></svg>
      <div className="workflow-lane workflow-public">
        <div className="workflow-lane-label"><strong>{coverageNode ? 'Public baseline' : 'Public checks'}</strong><small>{coverageNode ? 'Four shared checks' : 'Shared public baseline'}</small></div>
        <ol aria-label="Public assessment workflow">{publicNodes.map((node, index) => nodeButton(node, index, index === 0 ? 'shield' : index === 1 ? 'globe' : 'agent'))}</ol>
      </div>
      {accessNodes.length > 0 && <div className="workflow-lane workflow-access">
        <div className="workflow-lane-label" style={{order: publicNodes.length * 10 + 6}}><strong>{coverageNode ? 'Combined investigation' : 'Behind the login'}</strong><small>{coverageNode ? 'Verify access, then investigate' : 'Additional grey-box checks'}</small></div>
        <ol aria-label="Additional authenticated workflow">{accessNodes.map((node, index) => nodeButton(node, index + publicNodes.length, node.id === 'public_analysis' ? 'agent' : 'lock'))}</ol>
      </div>}
      <div className="workflow-lane workflow-output">
        <div className="workflow-lane-label" style={{order: (route.length - 1) * 10 + 6}}><strong>Evidence review</strong></div>
        <ol aria-label="Report workflow">{nodeButton(reportNode, publicNodes.length + accessNodes.length, 'file')}</ol>
      </div>
      {toolCluster('Scoped tools', scopedTools, `1 / span ${baselineIds.length}`, baselineIds.length * 10 + 5, 'baseline')}
      {toolCluster('Discovery follow-up', toolNodes.filter(node => node.id === 'tool-zap-discoveries'), String(investigationIndex + 1), (investigationIndex + 1) * 10 + 5, 'follow-up')}
      {toolCluster('Coverage summary', toolNodes.filter(node => node.id === 'tool-patchriot-coverage'), '-2 / -1', route.length * 10 + 5, 'coverage')}
    </div>
    <p className="workflow-status-help"><strong>Recorded = saved work.</strong> {toolNodes.length ? 'Dashed branches show tool evidence for this agent. Select a step or tool to inspect it.' : 'Select a step to inspect its evidence.'}</p>
    <section ref={inspector} className="workflow-inspector" aria-label="Selected workflow step">
      <div><span className="assessment-kicker">STEP DETAILS</span><h5>{selected.title}</h5><p>{selected.description}</p></div>
      <div className="workflow-inspector-state" data-status={selected.status}><strong>{label(selected)}</strong><p>{selected.detail ?? (selected.status === 'not_recorded' ? 'No structured execution record was retained. A report or heartbeat does not establish that this step finished.' : 'Select the recorded evidence in the report to inspect what the target returned.')}</p></div>
      {(selected.evidence_count !== undefined || selected.source_role || selected.measured_duration_ms !== undefined) && <dl>{selected.summary_counts && <><div><dt>Summary entries shown</dt><dd>{selected.summary_counts.shown}</dd></div><div><dt>Additional summary entries</dt><dd>{selected.summary_counts.omitted}</dd></div></>}<div><dt>{selected.summary_counts ? 'Linked HTTP requests' : 'Evidence records'}</dt><dd>{selected.evidence_count ?? '—'}</dd></div>{selected.measured_duration_ms !== undefined && selected.tool !== 'patchriot-coverage' && <div><dt>Recorded tool time</dt><dd>{Math.round(selected.measured_duration_ms / 1000)}s</dd></div>}{selected.source_role && <div><dt>Evidence source</dt><dd>{selected.source_role}</dd></div>}</dl>}
    </section>
    <p className="workflow-footnote">{workflowCaveat}</p>
  </div>;
}
