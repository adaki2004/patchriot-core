import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { UIIcon } from './UIIcon';

/** Decorative local animation. It never reads, represents or sends customer work. */
export function SwarmSignal({ paused }: { paused: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    let width = 0, height = 0, frame = 0, last = 0, phase = 0, visible = false;
    const colors = ['#769aff', '#ff6756'];
    function paint() {
      context!.clearRect(0, 0, width, height);
      context!.font = '10px monospace';
      // Orbiting probes pass a packet around a shared target; the sketch is not telemetry.
      const cx = width * .54, cy = height * .5;
      const radius = Math.min(width * .38, height * .39);
      const points = Array.from({ length: 48 }, (_, index) => {
        const angle = index * 2.39996 + phase * .13;
        const z = 1 - 2 * (index + .5) / 48;
        const ring = Math.sqrt(1 - z * z);
        return { x: cx + Math.cos(angle) * ring * radius, y: cy + (z * .72 + Math.sin(angle) * ring * .32) * radius, depth: Math.sin(angle) };
      });
      points.forEach((p, index) => {
        context!.globalAlpha = .18 + (p.depth + 1) * .18;
        context!.fillStyle = colors[index % 7 === 0 ? 1 : 0];
        context!.fillText(['+', '×', ':', '01', '{}', '·'][index % 6], p.x, p.y);
        if (index % 5 === 0) {
          const next = points[(index + 9) % points.length];
          context!.globalAlpha = .19;
          context!.strokeStyle = colors[0];
          context!.beginPath(); context!.moveTo(p.x, p.y); context!.lineTo(next.x, next.y); context!.stroke();
          const travel = (phase * .2 + index / 48) % 1;
          context!.globalAlpha = .85;
          context!.fillRect(p.x + (next.x - p.x) * travel - 2, p.y + (next.y - p.y) * travel - 2, 4, 4);
        }
      });
      context!.globalAlpha = 1;
    }
    function loop(now: number) {
      if (!visible || document.hidden || paused) { frame = 0; return; }
      if (now - last >= 50) { phase += .035; paint(); last = now; }
      frame = requestAnimationFrame(loop);
    }
    function start() { if (!frame && visible && !document.hidden && !paused) frame = requestAnimationFrame(loop); }
    function resize() {
      const bounds = canvas!.getBoundingClientRect(); width = bounds.width; height = bounds.height;
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.round(width * scale); canvas!.height = Math.round(height * scale);
      context!.setTransform(scale, 0, 0, scale, 0, 0); paint();
    }
    const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(canvas);
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; start(); }); observer.observe(canvas);
    document.addEventListener('visibilitychange', start);
    resize();
    return () => { cancelAnimationFrame(frame); resizeObserver.disconnect(); observer.disconnect(); document.removeEventListener('visibilitychange', start); };
  }, [paused]);
  return <canvas ref={ref} className="swarm-signal" aria-hidden="true" />;
}

const paths = [
  'M100 180 L250 100 L400 200', 'M105 315 L250 300 L400 200',
  'M400 200 L550 100 L700 180', 'M400 200 L550 300 L695 315',
  'M250 100 L250 300', 'M550 100 L550 300', 'M250 100 L550 100', 'M250 300 L550 300',
];

/** Identical geometry on both sides of the comparison; only ownership and colour change. */
export function CoordinationMap({ privateSwarm, paused }: { privateSwarm: boolean; paused: boolean }) {
  const nodes = [[100, 180], [105, 315], [250, 100], [250, 300], [550, 100], [550, 300], [700, 180], [695, 315]];
  return <svg className={`coordination-map ${privateSwarm ? 'private-map' : 'public-map'}`} viewBox="0 0 800 400" aria-hidden="true">
    <defs><pattern id={privateSwarm ? 'private-grid' : 'public-grid'} width="25" height="25" patternUnits="userSpaceOnUse"><path d="M25 0H0V25" fill="none" stroke="currentColor" strokeOpacity=".09" /></pattern></defs>
    <rect width="800" height="400" fill={`url(#${privateSwarm ? 'private-grid' : 'public-grid'})`} />
    <rect className="map-boundary" x="45" y="48" width="710" height="305" /><text x="62" y="70" className="map-caption">{privateSwarm ? 'YOUR NETWORK / YOUR OPERATORS' : 'PUBLIC NETWORK / APPROVED CONTRIBUTORS'}</text>
    {paths.map((path, index) => <g key={path}><path className={`map-link link-${index % 2}`} d={path} />{paused ? <rect x={nodes[index][0] - 3} y={nodes[index][1] - 3} width="6" height="6" className="map-packet" /> : <rect x="-3" y="-3" width="6" height="6" className="map-packet"><animateMotion dur={`${4 + index % 3}s`} begin={`${-index * .7}s`} repeatCount="indefinite" path={path} /></rect>}</g>)}
    {nodes.map(([x, y], index) => <g key={index} transform={`translate(${x},${y})`}><rect className={`map-node node-${index % 2}`} x="-17" y="-17" width="34" height="34" /><path className="map-face" d="M-8-3h4m8 0h4M-6 6H6" /><text className="node-label" y="34" textAnchor="middle">{['INVESTIGATE', 'REPRODUCE', 'CHALLENGE', 'REVIEW'][index % 4]}</text></g>)}
    <g transform="translate(400 200)"><path className="map-target" d="M0-42 42-20 42 24 0 46-42 24-42-20ZM0 2V46M-42-20 0 2 42-20" /><text className="map-caption" x="0" y="70" textAnchor="middle">YOUR SCOPE</text></g>
  </svg>;
}

/** The same infrastructure, operated by Patchriot or by the customer's own team. */
export function NetworkDeployments({ publicAction, privateAction }: { publicAction?: ReactNode; privateAction?: ReactNode }) {
  return <div className="review-blueprint blueprint-deployments" aria-label="Public and private network deployments">
    {[
      { name: 'Public network', tag: 'HOSTED PRIVATE BETA', description: 'Get a review from approved contributors.', owner: 'Patchriot dispatcher', agents: 'Approved contributors', note: 'Choose who receives your material. Your reports stay private to your account.', action: publicAction },
      { name: 'Your private network', tag: 'SELF-HOSTED / MANUAL SETUP', description: 'Use Patchriot’s infrastructure to connect your team’s agents.', owner: 'Your dispatcher', agents: 'Your operators and machines', note: 'Your deployment, access rules and evidence. Managed setup is planned.', action: privateAction },
    ].map(item => <section key={item.name}><span>{item.tag}</span><h4>{item.name}</h4><p className="deployment-description">{item.description}</p><div className="deployment-node"><UIIcon name="grid" /><strong>{item.owner}</strong></div><small>↕ PRIVATE MESH CONNECTION</small><div className="deployment-node"><UIIcon name="agent" /><strong>{item.agents}</strong></div><p>{item.note}</p>{item.action && <footer>{item.action}</footer>}</section>)}
  </div>;
}
