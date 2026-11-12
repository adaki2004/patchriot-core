import type { LiveRole, LiveStep, LiveToolRun } from './LiveReport';

export type ExposureRequest = { ref: string; status: number | null; context: 'Public' | 'Signed-in'; login: boolean; account?: 'testing' | 'reference'; stages: string[]; failed: boolean };
export type ExposureRoute = { key: string; origin: string; path: string; method: string; queryNames: string[]; statuses: number[]; contexts: string[]; refs: string[]; stages: string[]; requests: number; failed: number; records: ExposureRequest[] };
export type ExposureStage = { id: string; label: string; tools: string[]; routeKeys: string[]; requests: number; roles: string[] };
export type ExposureData = {
  origins: string[]; routes: ExposureRoute[]; stages: ExposureStage[];
  technologies: { name: string; refs: string[] }[];
  headers: { name: string; present: number; responses: number }[];
  services: { origin: string; host: string; protocol: string; port: number; responses: number }[];
  requests: number; excluded: number; firstObserved?: number; lastObserved?: number;
};

const roles: Record<LiveRole, string> = { investigator: 'Scout', reproducer: 'Recon', challenger: 'Verifier' };
const labels: Record<string, string> = { baseline: 'Headers & config', mapping: 'Route mapping', signatures: 'Known signatures', fingerprints: 'Web fingerprints', discovery: 'Web & API checks', deep: 'Deep scan', access: 'Sign-in checks', agent: 'Agent follow-up' };
const headerNames = ['content-security-policy', 'strict-transport-security', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'x-frame-options'];
const knownTechnologies = new Set(['Apache', 'nginx', 'IIS', 'Jetty', 'Apache Tomcat', 'PHP', 'ASP.NET', 'Generator', 'Drupal CMS', 'WordPress', 'Joomla', 'Drupal', 'Django', 'Laravel', 'GitLab', 'Jenkins', 'Grafana']);

function stageOf(tool: LiveToolRun): string {
  if (tool.tool === 'patchriot-deep' || tool.arguments.includes('--deep-suite')) return 'deep';
  if (tool.tool === 'patchriot-discovery' || tool.arguments.includes('--discovery-suite')) return 'discovery';
  return ({ 'patchriot-baseline': 'baseline', 'patchriot-crawl': 'mapping', nuclei: 'signatures', 'ares-web-surface': 'fingerprints', 'artex-engine': 'discovery' } as Record<string, string>)[tool.tool] ?? 'agent';
}

/** Summarize already-private HTTP evidence. No new probes, response bodies,
 * credentials, query values, or scanner loopback addresses enter this view. */
export function exposureData(steps: LiveStep[], origins: string[]): ExposureData {
  const allowed = new Set<string>();
  for (const origin of origins) {
    try { const url = new URL(origin); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) allowed.add(url.origin); } catch { /* Invalid scope is not an observed host. */ }
  }
  const routes = new Map<string, ExposureRoute>();
  const stages = new Map<string, ExposureStage>();
  const services = new Map<string, ExposureData['services'][number]>();
  const technologies = new Map<string, Set<string>>();
  const headers = headerNames.map(name => ({ name, present: 0, responses: 0 }));
  const seen = new Set<string>();
  let requests = 0, excluded = 0, firstObserved: number | undefined, lastObserved: number | undefined;
  for (const step of steps) {
    const evidence = step.result?.evidence ?? [];
    const byEvidence = new Map<number, LiveToolRun[]>();
    for (const tool of step.result?.tool_runs ?? []) {
      // Summary ledgers describe other checks; they are not additional probes.
      if (tool.tool === 'patchriot-coverage') continue;
      for (const id of new Set(tool.evidence_ids)) byEvidence.set(id, [...(byEvidence.get(id) ?? []), tool]);
    }
    const included = new Map<number, string>();
    for (const record of evidence) {
      const ref = `${roles[step.role]} #${record.id}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      let url: URL;
      try { url = new URL(record.url); } catch { excluded++; continue; }
      if (!allowed.has(url.origin) || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) { excluded++; continue; }
      requests++;
      included.set(record.id, ref);
      const method = /^[A-Z]{1,12}$/.test(record.method) ? record.method : 'OTHER';
      const key = JSON.stringify([url.origin, url.pathname, method]);
      const row = routes.get(key) ?? { key, origin: url.origin, path: url.pathname, method, queryNames: [], statuses: [], contexts: [], refs: [], stages: [], requests: 0, failed: 0, records: [] };
      row.requests++;
      row.refs.push(ref);
      const status = record.status !== null && Number.isInteger(record.status) && record.status >= 100 && record.status <= 599 ? record.status : undefined;
      if (status !== undefined) row.statuses = [...new Set([...row.statuses, status])];
      if (record.error || status === undefined) row.failed++;
      row.queryNames = [...new Set([...row.queryNames, ...url.searchParams.keys()])].sort();
      const context = record.authenticated ? 'Signed-in' : 'Public';
      // Login is an activity, not a third authentication state. Anonymous
      // credential submissions still belong in the Public filter.
      row.contexts = [...new Set([...row.contexts, context, ...(record.login ? ['Sign-in step'] : [])])];
      const tools = byEvidence.get(record.id) ?? [];
      const groups = new Set(tools.map(stageOf));
      if (record.login) groups.add('access');
      if (!groups.size) groups.add('agent');
      for (const id of groups) {
        const stage = stages.get(id) ?? { id, label: labels[id], tools: [], routeKeys: [], requests: 0, roles: [] };
        stage.requests++;
        stage.routeKeys = [...new Set([...stage.routeKeys, key])];
        stage.tools = [...new Set([...stage.tools, ...tools.filter(tool => stageOf(tool) === id).map(tool => tool.tool)])];
        stage.roles = [...new Set([...stage.roles, roles[step.role]])];
        stages.set(id, stage);
        row.stages = [...new Set([...row.stages, id])];
      }
      row.records.push({ ref, status: status ?? null, context, login: record.login === true, account: record.account, stages: [...groups], failed: Boolean(record.error || status === undefined) });
      routes.set(key, row);
      if (record.observed_at && Number.isFinite(record.observed_at)) {
        firstObserved = Math.min(firstObserved ?? record.observed_at, record.observed_at);
        lastObserved = Math.max(lastObserved ?? record.observed_at, record.observed_at);
      }
      if (status !== undefined && !record.error) {
        // A real HTTP response establishes this web service, not a network scan.
        const service = services.get(url.origin) ?? { origin: url.origin, host: url.hostname, protocol: url.protocol.slice(0, -1).toUpperCase(), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), responses: 0 };
        service.responses++;
        services.set(url.origin, service);
        const fields = new Set(Object.keys(record.headers).map(name => name.toLowerCase()));
        for (const header of headers) { header.responses++; if (fields.has(header.name)) header.present++; }
      }
    }
    for (const tool of step.result?.tool_runs ?? []) {
      if (tool.tool !== 'ares-web-surface') continue;
      try {
        const output = JSON.parse(tool.output_excerpt);
        const add = (hints: unknown, id: unknown) => {
          if (typeof id !== 'number' || !included.has(id) || !tool.evidence_ids.includes(id) || !Array.isArray(hints)) return;
          for (const name of hints) if (knownTechnologies.has(name)) {
            const refs = technologies.get(name) ?? new Set<string>(); refs.add(included.get(id)!); technologies.set(name, refs);
          }
        };
        add(output.technology_hints, output.root_evidence_id);
        if (Array.isArray(output.observations)) for (const entry of output.observations) if (entry && typeof entry === 'object') add(entry.technology_hints, entry.evidence_id);
      } catch { /* Truncated or older receipts do not establish fingerprints. */ }
    }
  }
  return { origins: [...allowed], routes: [...routes.values()].sort((a, b) => a.origin.localeCompare(b.origin) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method)), stages: Object.keys(labels).flatMap(id => stages.has(id) ? [stages.get(id)!] : []), technologies: [...technologies].map(([name, refs]) => ({ name, refs: [...refs] })), services: [...services.values()], headers, requests, excluded, firstObserved, lastObserved };
}
