import type { LiveWorkflow, WorkflowCheckId, WorkflowCheckState } from './LiveReport';

export const checkDefinitions: { id: WorkflowCheckId; title: string; tool: string; description: string }[] = [
  { id: 'public_baseline', title: 'Headers & config', tool: 'Patchriot baseline', description: 'Inspect public response headers, browser policies and exposed configuration without a signed-in session.' },
  { id: 'public_mapping', title: 'Map routes', tool: 'Patchriot crawl', description: 'Map reachable public pages, links and forms within the approved origin.' },
  { id: 'public_signatures', title: 'Known signatures', tool: 'Nuclei', description: 'Run the curated signature checks against public responses. Matches are leads to investigate.' },
  { id: 'public_fingerprints', title: 'Web fingerprints', tool: 'ARES', description: 'Compare public technology and content fingerprints with missing-path controls.' },
  { id: 'public_analysis', title: 'Deeper public checks', tool: 'ARTEX', description: 'Investigate the public attack surface within the saved scope and remaining limits.' },
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
