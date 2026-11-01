import { useCallback, useEffect, useState } from 'react';
import { isDocPage } from './docs-pages';

const views = ['home', 'overview', 'request', 'docs', 'devices', 'agents', 'reviews', 'orders', 'sites', 'sources', 'guide', 'incidents', 'incident-desk', 'payment-desk', 'access-desk'] as const;
export type View = typeof views[number];
type Route = { view: View; id: string | null; report: boolean };
const home: Route = { view: 'overview', id: null, report: false };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readRoute(): Route {
  const [view, id, report, ...extra] = window.location.hash.replace(/^#\//, '').split('/');
  if (!views.includes(view as View) || extra.length) return home;
  if (view === 'docs') return !report && (id === undefined || isDocPage(id)) ? { view: 'docs', id: id ?? 'start', report: false } : home;
  if (id !== undefined && (!['reviews', 'sites', 'sources', 'orders'].includes(view) || !uuid.test(id))) return home;
  if (report !== undefined && (view !== 'orders' || report !== 'report')) return home;
  return { view: view as View, id: id ?? null, report: report === 'report' };
}

/** URLs hold view names and record IDs only. Sessions still authorize each read. */
export function useNavigation() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const changed = () => setRoute(readRoute());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const navigate = useCallback((view: View, id: string | null = null, report = false, replace = false) => {
    const hash = `#/${view}${id ? `/${id}${report && view === 'orders' ? '/report' : ''}` : ''}`;
    if (window.location.hash === hash) return;
    const changingView = readRoute().view !== view;
    if (replace) window.history.replaceState(null, '', hash);
    else window.history.pushState(null, '', hash);
    setRoute(readRoute());
    // New sections start at the top; Back/Forward retain the browser's saved position.
    if (changingView) window.scrollTo(0, 0);
  }, []);
  return { route, navigate };
}
