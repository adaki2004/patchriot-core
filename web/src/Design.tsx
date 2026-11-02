import { useState } from 'react';

export const designs = [
  { id: 'paper', name: 'Field notes', type: 'Newsreader / Source Sans', note: 'An editorial page and a quiet, ruled workspace.' },
  { id: 'signal', name: 'Signal', type: 'Barlow Condensed / Barlow', note: 'Tall type, a compact grid and direct controls.' },
  { id: 'terminal', name: 'Terminal', type: 'IBM Plex Mono', note: 'A monochrome console with a single reading column.' },
  { id: 'studio', name: 'Common ground', type: 'Bricolage Grotesque / Lora', note: 'Rounder headings, a bookish body and open spacing.' },
] as const;
type Design = typeof designs[number]['id'];

function current(): Design {
  const value = new URLSearchParams(window.location.search).get('design');
  return designs.find(item => item.id === value)?.id ?? 'paper';
}
document.documentElement.dataset.design = current();

/** Preview choices affect presentation only; they cannot select an API or account. */
export function DesignPreview() {
  const [selected, select] = useState(current);
  if (!new URLSearchParams(window.location.search).has('design')) return null;
  function choose(id: Design) {
    const url = new URL(window.location.href);
    url.searchParams.set('design', id);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    document.documentElement.dataset.design = id;
    select(id);
  }
  return <aside className="design-preview" aria-label="Design previews">
    <span>Design preview</span>
    <div>{designs.map((item, index) => <button key={item.id} onClick={() => choose(item.id)} aria-pressed={selected === item.id} title={`${item.type}. ${item.note}`}>{index + 1}. {item.name}</button>)}</div>
    <small>{designs.find(item => item.id === selected)?.type}</small>
  </aside>;
}
