import type { LiveWorkflow, LiveToolRun, WorkflowCheckId, WorkflowCheckState } from './LiveReport';

export const checkDefinitions: { id: WorkflowCheckId; title: string; tool: string; description: string }[] = [
  { id: 'public_baseline', title: 'Headers & config', tool: 'Patchriot baseline', description: 'Inspect public response headers, browser policies and exposed configuration without a signed-in session.' },
  { id: 'public_mapping', title: 'Map routes', tool: 'Patchriot crawl', description: 'Map reachable public pages, links and forms within the approved origin.' },
  { id: 'public_signatures', title: 'Known signatures', tool: 'Nuclei', description: 'Run the curated signature checks against public responses. Matches are leads to investigate.' },
  { id: 'public_fingerprints', title: 'Web fingerprints', tool: 'ARES-engine', description: 'Compare public technology and content fingerprints with missing-path controls.' },
  { id: 'public_analysis', title: 'Deeper public checks', tool: 'ARTEX_public-engine', description: 'Investigate the public attack surface within the saved scope and remaining limits.' },
  { id: 'authentication', title: 'Verify access', tool: 'Relay access proof', description: 'Establish the permitted account or disposable-wallet access and record an anonymous comparison.' },
  { id: 'authenticated_checks', title: 'Signed-in checks', tool: 'Signed-in investigation', description: 'Inspect signed-in resources under the saved permission, in addition to public checks. Recorded means requests were made with verified access; the evidence shows what was actually tested.' },
  { id: 'evidence_review', title: 'Review & report', tool: 'Agent assessment', description: 'Review claims against evidence, retain uncertainty and produce this role’s assessment.' },
];

export const workflowStateLabels: Record<WorkflowCheckState | 'not_recorded', string> = {
  pending: 'Waiting', running: 'Running', recorded: 'Recorded', reused: 'Reused evidence',
  incomplete: 'Incomplete', not_applicable: 'Not in scope', not_recorded: 'Not recorded',
};
export const workflowCaveat = 'Recorded means work or access evidence was returned. It does not mean complete coverage or a finding-free website.';
export const workflowAbsent = 'Structured checklist not recorded for this role.';
const sourceRoles = { investigator: 'Scout', reproducer: 'Recon', challenger: 'Verifier' };
/** Retain explicit gaps without inventing execution states for historical reports. */
export function workflowRecordLines(workflow: LiveWorkflow | undefined): string[] {
  if (workflow?.version !== 1) return [];
  return checkDefinitions.flatMap(definition => {
    const check = workflow.checks.find(check => check.id === definition.id);
    if (!check) return [`${definition.title} (${definition.tool}): Not recorded (no checklist entry)`];
    const state = check.state === 'running' ? 'Last reported running' : workflowStateLabels[check.state];
    return [`${definition.title} (${definition.tool}): ${state} · ${check.evidence_count} evidence records${check.source_role ? ` · Source: ${sourceRoles[check.source_role]}` : ''}`];
  });
}

export function workflowToolName(tool: string, record?: LiveToolRun) {
  if (record && combinedEngineAccess(record)) return 'ARTEX-engine';
  const names: Record<string, string> = { 'patchriot-probes': 'HTTP controls', ffuf: 'Endpoint discovery', zap: 'Web security scanner', schemathesis: 'API schema checks', 'patchriot-coverage': 'Evidence coverage' };
  if (names[tool]) return names[tool];
  return tool === 'artex-engine' ? 'ARTEX_public-engine' : tool === 'ares-web-surface' ? 'ARES-engine' : tool;
}
export function combinedEngineAccess(tool: LiveToolRun): { anonymous: number; authenticated: number } | undefined {
  if (tool.tool !== 'artex-engine') return undefined;
  try {
    const receipt = JSON.parse(tool.output_excerpt);
    const counts = [receipt.anonymous_evidence_count, receipt.authenticated_evidence_count];
    if (receipt.receipt_schema === 1 && receipt.access_mode === 'anonymous_and_authenticated'
      && counts.every(count => Number.isSafeInteger(count) && count >= 0)) {
      return { anonymous: counts[0], authenticated: counts[1] };
    }
  } catch { /* Older or shortened receipts can omit structured access metadata. */ }
  return undefined;
}

/** Display known receipt metadata only; target/model text never becomes an execution diagnosis. */
export function toolCoverageDetail(tool: LiveToolRun): string | undefined {
  if (tool.tool !== 'artex-engine') return undefined;
  try {
    const receipt = JSON.parse(tool.output_excerpt);
    if (receipt.receipt_schema !== 1 || receipt.coverage_complete !== false) return undefined;
    const reasons: Record<string, string> = {
      target_request_budget: 'Reached this tool’s request limit. Deeper public coverage remains incomplete.',
      time_budget: 'Reached this tool’s time limit. Deeper public coverage remains incomplete.',
      model_budget: 'Reached this tool’s model budget. Deeper public coverage remains incomplete.',
      no_target_progress: 'Stopped after no further target progress. Deeper public coverage remains incomplete.',
      interrupted: 'The engine was interrupted before a finished receipt. Deeper public coverage remains incomplete.',
    };
    const reason = reasons[receipt.stop_reason];
    return combinedEngineAccess(tool) ? reason?.replace('Deeper public coverage', 'Combined public and signed-in coverage') : reason;
  } catch { return undefined; }
}
