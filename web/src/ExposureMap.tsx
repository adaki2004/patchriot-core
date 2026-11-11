import { useMemo, useState } from 'react';
import type { ExposureData, ExposureRoute, ExposureStage } from './exposure';
import { UIIcon } from './UIIcon';
import './exposure-map.css';

const headerLabels: Record<string, string> = { 'content-security-policy': 'Content security policy', 'strict-transport-security': 'HTTPS policy (HSTS)', 'x-content-type-options': 'Content type policy', 'referrer-policy': 'Referrer policy', 'permissions-policy': 'Permissions policy', 'x-frame-options': 'Frame policy' };
const pageSize = 7;
const stageOrder = ['baseline', 'mapping', 'signatures', 'fingerprints', 'access', 'discovery', 'deep', 'agent'];
const stageIcons = { baseline: 'shield', mapping: 'globe', signatures: 'scan', fingerprints: 'code', discovery: 'scan', deep: 'grid', access: 'lock', agent: 'agent' } as const;
const roleNames: Record<string, string> = { investigator: 'Scout', reproducer: 'Recon', challenger: 'Verifier' };
const contextNames: Record<string, string> = { Public: 'Public', 'Signed-in': 'Signed in', 'Sign-in step': 'Login flow' };
const count = (n: number) => n.toLocaleString();
const host = (origin: string) => { try { return new URL(origin).host; } catch { return origin; } };
type AccessFilter = 'all' | 'Public' | 'Signed-in' | 'Sign-in step';
type ResponseFilter = 'all' | 'response' | 'denied' | 'missing' | 'none';
function responseLabel(route: ExposureRoute) {
  if (!route.statuses.length) return 'No response';
  if (route.statuses.every(status => status === 401 || status === 403)) return 'Access denied';
  if (route.statuses.every(status => status === 404 || status === 410)) return 'Not found';
  return 'HTTP response';
}

function RouteDetails({ route, stages }: { route: ExposureRoute; stages: ExposureStage[] }) {
  const [showReferences, setShowReferences] = useState(false);
  return <div className="exposure-inspector" aria-label="Selected route details">
    <div className="exposure-inspector-title"><span>{route.method}</span><code>{route.path}</code></div>
    <dl>
      <div><dt>Host</dt><dd>{host(route.origin)}</dd></div>
      <div><dt>Response codes</dt><dd>{route.statuses.length ? route.statuses.join(' · ') : 'No HTTP response recorded'}</dd></div>
      <div><dt>Request context</dt><dd>{route.contexts.map(c => contextNames[c] ?? c).join(' · ') || 'Not recorded'}</dd></div>
      <div><dt>Recorded requests</dt><dd>{count(route.requests)}{route.failed > 0 ? ` · ${count(route.failed)} with a request error` : ''}</dd></div>
      <div><dt>Observed by</dt><dd>{stages.filter(s => route.stages.includes(s.id)).map(s => s.label).join(' · ') || 'Agent request records'}</dd></div>
      {route.queryNames.length > 0 && <div><dt>Query parameter names</dt><dd>{route.queryNames.join(', ')}<small>Values are hidden.</small></dd></div>}
    </dl>
    <button type="button" className="exposure-ref-toggle" aria-expanded={showReferences} onClick={() => setShowReferences(value => !value)}>{showReferences ? 'Hide' : 'Show'} request references · {count(route.refs.length)}</button>
    {showReferences && <p className="exposure-reference-list">{route.refs.join(' · ')}</p>}
    <p className="exposure-detail-note">An HTTP response records behavior, not a vulnerability. A successful status can also be a shared app shell or error page.</p>
  </div>;
}

/** A private, read-only map of retained observations. It makes no new target requests. */
export function ExposureMap({ data, pending }: { data: ExposureData; pending: boolean }) {
  const [stageId, setStageId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [access, setAccess] = useState<AccessFilter>('all');
  const [response, setResponse] = useState<ResponseFilter>('all');
  const [page, setPage] = useState(0);
  const [routeKey, setRouteKey] = useState<string | null>(null);
  const stages = useMemo(() => [...data.stages].sort((a, b) => stageOrder.indexOf(a.id) - stageOrder.indexOf(b.id)), [data.stages]);
  const selectedStage = stages.find(stage => stage.id === stageId);
  const routes = useMemo(() => data.routes.filter(route => (!selectedStage || route.stages.includes(selectedStage.id))
    && (access === 'all' || route.contexts.includes(access))
    && (response === 'all' || response === 'response' && route.statuses.length > 0 || response === 'denied' && route.statuses.some(status => status === 401 || status === 403) || response === 'missing' && route.statuses.some(status => status === 404 || status === 410) || response === 'none' && route.failed > 0)
    && (!query.trim() || `${route.origin} ${route.path} ${route.method} ${route.queryNames.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))), [data.routes, selectedStage, access, response, query]);
  const pages = Math.max(1, Math.ceil(routes.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visibleRoutes = routes.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const selectedRoute = routes.find(route => route.key === routeKey);
  const hasData = data.routes.length > 0;
  function chooseStage(id: string | null) { setStageId(id); setPage(0); setRouteKey(null); }

  return <section className="exposure-map" aria-labelledby="exposure-map-title">
    <header className="exposure-heading"><div><span className="exposure-eyebrow">See what hackers see</span><h3 id="exposure-map-title">What your site exposes</h3><p>A map of what the assessment observed. Separate from vulnerabilities.</p></div><span className="exposure-record-label"><UIIcon name="scan" />{pending ? 'Saved observations so far' : 'Recorded observations'}</span></header>
    {!hasData ? <div className="exposure-empty"><UIIcon name="globe" /><div><strong>{pending ? 'The map fills in when an agent returns its records.' : 'No route observations were retained.'}</strong><p>{pending ? 'Progress above shows current work. This view needs saved request evidence.' : 'That does not mean the website has no exposed surface. Check the assessment’s coverage limits.'}</p></div></div> : <>
      <div className="exposure-metrics" aria-label="Observed surface summary">
        <div><strong>{count(data.routes.length)}</strong><span>Paths & methods checked</span></div>
        <div><strong>{count(data.requests)}</strong><span>Recorded requests</span></div>
        <div><strong>{count(data.services.length)}</strong><span>HTTP services observed</span></div>
        <div><strong>{count(data.technologies.length)}</strong><span>Technology hints</span></div>
      </div>
      <div className="exposure-console">
        <div className="exposure-topology">
          <button className="exposure-target" type="button" aria-pressed={!selectedStage} onClick={() => chooseStage(null)}><span className="exposure-target-mark"><UIIcon name="globe" /></span><span><small>Assessment target</small><strong>{data.origins.length === 1 ? host(data.origins[0]) : `${data.origins.length} approved origins`}</strong><em>All recorded routes</em></span></button>
          <div className="exposure-stage-tree" role="group" aria-label="Filter observations by assessment stage">{stages.map(stage => <button key={stage.id} type="button" className="exposure-stage" data-related={selectedRoute?.stages.includes(stage.id) ?? false} aria-pressed={selectedStage?.id === stage.id} onClick={() => chooseStage(selectedStage?.id === stage.id ? null : stage.id)}><span className="exposure-stage-mark"><UIIcon name={stageIcons[stage.id as keyof typeof stageIcons] ?? 'scan'} /></span><span><strong>{stage.label}</strong><small>{stage.roles.map(role => roleNames[role] ?? role).join(' · ') || 'Saved tool records'}</small></span><b>{count(stage.routeKeys.length)}<span className="exposure-sr-only"> route and method pairs</span></b></button>)}</div>
          <p className="exposure-map-key"><span aria-hidden="true" />Select a check to trace its observations.<br />Connections show source, not execution order. Counts can overlap.</p>
        </div>
        <div className="exposure-route-panel">
          <div className="exposure-route-heading"><div><span className="exposure-eyebrow">{selectedStage ? 'Selected branch' : 'Surface inventory'}</span><h4>{selectedStage?.label ?? 'Paths checked'}</h4></div><span>{count(routes.length)} path / method pairs</span></div>
          {selectedStage && <p className="exposure-stage-source">{selectedStage.tools.join(' · ')}</p>}
          <div className="exposure-filters"><label className="exposure-search"><UIIcon name="scan" /><span className="exposure-sr-only">Search observed routes</span><input type="search" value={query} placeholder="Search paths or methods" onChange={event => { setQuery(event.target.value); setPage(0); setRouteKey(null); }} /></label><label><span className="exposure-sr-only">Filter request context</span><select value={access} onChange={event => { setAccess(event.target.value as AccessFilter); setPage(0); setRouteKey(null); }}><option value="all">All contexts</option><option value="Public">Public requests</option><option value="Signed-in">Signed-in requests</option><option value="Sign-in step">Login flow</option></select></label><label><span className="exposure-sr-only">Filter observed responses</span><select value={response} onChange={event => { setResponse(event.target.value as ResponseFilter); setPage(0); setRouteKey(null); }}><option value="all">All responses</option><option value="response">HTTP responses</option><option value="denied">401 / 403 denied</option><option value="missing">404 / 410 not found</option><option value="none">Request errors</option></select></label></div>
          <div className="exposure-route-list" role="group" aria-label="Observed routes">{visibleRoutes.length ? visibleRoutes.map(route => <button type="button" key={route.key} className="exposure-route" aria-pressed={routeKey === route.key} onClick={() => setRouteKey(routeKey === route.key ? null : route.key)}><span className="exposure-route-method">{route.method}</span><span className="exposure-route-path"><code>{route.path}</code><small>{data.origins.length > 1 ? `${host(route.origin)} · ` : ''}{route.contexts.map(context => contextNames[context] ?? context).join(' / ') || 'Context not recorded'}{route.queryNames.length > 0 ? ` · ${route.queryNames.length} parameter name${route.queryNames.length === 1 ? '' : 's'}` : ''}</small></span><span className="exposure-response" data-denied={route.statuses.some(status => status === 401 || status === 403)}>{route.statuses.length ? route.statuses.slice(0, 3).join(' / ') : 'No reply'}{route.statuses.length > 3 ? '…' : ''}<small>{responseLabel(route)}</small></span></button>) : <p className="exposure-no-matches">No retained routes match these filters.</p>}</div>
          <div className="exposure-pagination"><span>{routes.length ? `${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, routes.length)} of ${count(routes.length)}` : '0 observations'}</span><div><button type="button" aria-label="Previous observed routes" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setRouteKey(null); }}>Previous</button><button type="button" aria-label="Next observed routes" disabled={currentPage + 1 >= pages} onClick={() => { setPage(currentPage + 1); setRouteKey(null); }}>Next</button></div></div>
          {selectedRoute ? <RouteDetails key={selectedRoute.key} route={selectedRoute} stages={stages} /> : <p className="exposure-inspect-hint"><UIIcon name="arrow" />Select a route to see its source, request contexts and references.</p>}
        </div>
      </div>
      <div className="exposure-signals">
        <section aria-label="Observed HTTP services"><h4><UIIcon name="globe" />Web services</h4><p>Ports that returned HTTP responses. This is not a port scan.</p><ul className="exposure-service-list">{data.services.map(service => <li key={service.origin}><span><strong>{service.protocol.toUpperCase()} <code>:{service.port}</code></strong><small>{service.host}</small></span><span>{count(service.responses)}<small>responses</small></span></li>)}</ul>{!data.services.length && <p>No service response was recorded.</p>}</section>
        <section aria-label="Observed response headers"><h4><UIIcon name="shield" />Header signals</h4><p>Presence in saved responses. Policy strength is assessed separately.</p><ul className="exposure-header-list">{data.headers.map(header => <li key={header.name}><span title={header.name}>{headerLabels[header.name] ?? header.name}</span><div><span className="exposure-header-track" aria-hidden="true"><i style={{width:`${header.responses ? Math.min(100, header.present / header.responses * 100) : 0}%`}} /></span><small>{count(header.present)} / {count(header.responses)}</small></div></li>)}</ul>{!data.headers.length && <p>No response header metadata was retained.</p>}</section>
        <section aria-label="Observed technology hints"><h4><UIIcon name="code" />Technology hints</h4><p>Fingerprints can be incomplete or misleading. No versions are inferred.</p><div className="exposure-technologies">{data.technologies.length ? data.technologies.map(technology => <details key={technology.name}><summary>{technology.name}<UIIcon name="plus" /></summary><p>{technology.refs.join(' · ')}</p></details>) : <p>No named technology was identified in the saved fingerprints.</p>}</div></section>
      </div>
    </>}
    <footer className="exposure-footnote"><span>{hasData ? 'Checked paths include missing routes and shared app shells. Signed-in observations are not necessarily public. This is not a security score.' : 'Only recorded observations appear here.'}</span>{data.excluded > 0 && <span>{count(data.excluded)} records omitted from this map because their scope or URL could not be verified.</span>}<span>Request bodies, credentials and query values are not displayed.</span></footer>
  </section>;
}
