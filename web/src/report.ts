import type { LiveFinding, LiveResult, LiveRole, LiveStep } from './LiveReport';

export const reportRoles = { investigator: 'Scout', reproducer: 'Recon', challenger: 'Verifier' } as const;
export const roleDuties = { investigator: 'Find leads and record what the website returned.', reproducer: 'Repeat the checks and challenge the initial findings.', challenger: 'Review the evidence, impact and proposed fixes.' };
export const severities = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const supportLabels: Record<string, string> = { observed: 'Observed', reproduced: 'Reproduction reported', not_reproduced: 'Not reproduced', needs_review: 'Unconfirmed' };
export type ReportInput = { id: string; state: string; created_at: number; origins: string[]; steps: LiveStep[]; methods?: string[]; profile?: string; scope_sha256?: string; team?: { device_id: string; operator_id: string; compute_group?: string | null }[] };
export type ReportFinding = { id: string; role: LiveRole; finding: LiveFinding; result: LiveResult; complete: boolean };

/** These are execution problems, never findings about the assessed website. */
export function stopExplanation(reason?: string): string {
  switch (reason) {
    case 'inference_limit': return 'The runner reached its model-request limit before the agent could finish its report. This is a testing limit, not a vulnerability in your website.';
    case 'provider_budget_reached': case 'engine_budget_reached': return 'The agent reached its allowed AI usage budget. Saved evidence is available, but the remaining checks were not completed.';
    case 'timed_out': case 'timeout': return 'The allowed testing time ended before this work finished.';
    case 'provider_unavailable': case 'provider_rejected_request': case 'provider_stream_interrupted': return 'The AI provider did not complete a request. The agent could not finish this stage.';
    case 'cancelled': return 'This stage was cancelled. Work already recorded remains available.';
    case 'invalid_tool_records': return 'The runner could not validate the recorded tool output. Its conclusions need review.';
    case undefined: return 'Some checks or supporting evidence are incomplete. Review the recorded limits before relying on these findings.';
    default: return 'The runner could not finish this stage. The technical details include its recorded stop reason.';
  }
}

export function roleOutcome(step: LiveStep): { label: string; detail: string } {
  if (!step.result) return ['running', 'leased'].includes(step.state) ? { label: 'Working', detail: roleDuties[step.role] } : ['waiting', 'queued'].includes(step.state) ? { label: 'Waiting', detail: 'This stage has not started.' } : { label: 'No report', detail: 'This stage ended without a saved report.' };
  if (!step.result.assessment) return { label: 'No assessment', detail: stopExplanation(step.result.execution.failure_reason) };
  return step.evidence_complete ? { label: 'Assessment received', detail: 'Findings and request evidence are available. The agent’s conclusions still need review.' } : { label: 'Partial assessment', detail: stopExplanation(step.result.execution.failure_reason) };
}

/** Preserve separate claims and provenance; matching titles are not a consensus. */
export function reportFindings(input: ReportInput): ReportFinding[] {
  return input.steps.flatMap(s => s.result?.assessment?.findings.map((finding, i) => ({
    id: `${({ investigator: 'S', reproducer: 'R', challenger: 'V' })[s.role]}-${String(i + 1).padStart(2, '0')}`,
    role: s.role, finding, result: s.result!, complete: s.evidence_complete === true,
  })) ?? []).sort((a, b) => severities.indexOf(a.finding.severity as typeof severities[number]) - severities.indexOf(b.finding.severity as typeof severities[number]));
}

export function reportSummary(input: ReportInput) {
  const findings = reportFindings(input);
  const assessments = input.steps.filter(s => !!s.result?.assessment).length;
  const complete = input.steps.filter(s => !!s.result?.assessment && s.evidence_complete).length;
  const requests = input.steps.reduce((sum, s) => sum + (s.result?.evidence.length ?? 0), 0);
  const finished = !['awaiting_payment', 'queued', 'running'].includes(input.state);
  const partial = complete < 3 || input.state !== 'completed';
  const headline = !finished ? 'Assessment in progress' : partial ? 'Partial assessment' : 'Assessment received';
  const description = `${assessments} of 3 agents returned usable assessments. ${findings.length} ${findings.length === 1 ? 'observation is' : 'observations are'} listed below${partial ? '; unfinished work is listed separately' : ''}. ${partial ? 'This run cannot establish that your website is safe.' : 'These are agent-reported findings, not a certification of security.'}`;
  return { findings, assessments, complete, requests, finished, partial, headline, description };
}

export function toolOutcome(run: NonNullable<LiveResult['tool_runs']>[number]) {
  if (run.failure || run.exit_code !== 0) return 'Incomplete';
  return 'Ran'; // A successful exit is neither full coverage nor proof of safety.
}

export function teamDescription(input: ReportInput) {
  if (!input.team?.length) return 'Team independence was not recorded. Multiple agent roles do not establish independent verification.';
  const operators = new Set(input.team.map(r => r.operator_id)).size;
  const groups = new Set(input.team.filter(r => r.compute_group).map(r => `${r.operator_id}:${r.compute_group}`)).size;
  return `${input.team.length} devices, ${operators} operator${operators === 1 ? '' : 's'}, ${groups} declared machine group${groups === 1 ? '' : 's'}. Shared operators, machines or models are not independent reviewers.`;
}

export const reportLimits = 'An automated assessment within the approved scope. It does not replace a full human penetration test. Tool matches and agent agreement do not prove exploitability. Suggested fixes have not been applied or retested.';

export type CoverageCheck = { id: string; origin: string; title: string; status: string; summary: string; evidence_ids: number[] };
export function coverageChecks(result: LiveResult | null): CoverageCheck[] {
  return (result?.tool_runs ?? []).filter(t => t.tool === 'patchriot-baseline' && !t.output_truncated).flatMap(t => {
    try {
      const data = JSON.parse(t.output_excerpt);
      if (data.profile !== 'web-checks-v1' || !Array.isArray(data.checks) || data.checks.length > 40) return [];
      return data.checks.filter((c: CoverageCheck) => c && ['id', 'origin', 'title', 'summary'].every(k => typeof c[k as keyof CoverageCheck] === 'string' && String(c[k as keyof CoverageCheck]).length <= 2000) && ['completed', 'finding', 'inconclusive', 'skipped', 'unsupported'].includes(c.status) && Array.isArray(c.evidence_ids) && c.evidence_ids.every(id => t.evidence_ids.includes(id) && result!.evidence.some(e => e.id === id)));
    } catch { return []; }
  });
}
export const checkLabels: Record<string, string> = { completed: 'Completed', finding: 'Potential issue', inconclusive: 'Inconclusive', skipped: 'Skipped', unsupported: 'Unsupported' };
