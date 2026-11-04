import { useEffect, useId, useRef, useState } from 'react';
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
  'M110 190 L300 190', 'M300 190 L510 190', 'M510 190 L750 190',
  'M750 215 L510 215', 'M510 235 L510 325 L300 325 L300 235',
];

/** Illustrates the architecture, never claims to show live activity. */
export function CoordinationMap({ paused }: { privateSwarm?: boolean; paused?: boolean }) {
  const grid = useId();
  const [localPaused, setLocalPaused] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { if (media.matches) setLocalPaused(true); };
    media.addEventListener('change', update); return () => media.removeEventListener('change', update);
  }, []);
  const stopped = paused ?? localPaused;
  return <div className="service-map animated-map" data-paused={stopped} aria-label="From your verified domain to a private security report">
    <div className="flow-permission"><span>YOU START HERE</span><strong>Verify your domain</strong><span aria-hidden="true">→</span><strong>Confirm access</strong></div>
    <svg className="coordination-map" viewBox="0 0 880 410" role="img" aria-label="Your verified website connects through the dispatcher to isolated Hermes agents. Encrypted model requests go to NEAR AI; private evidence returns to you.">
      <defs><pattern id={grid} width="25" height="25" patternUnits="userSpaceOnUse"><path d="M25 0H0V25" fill="none" stroke="currentColor" strokeOpacity=".09" /></pattern></defs>
      <rect width="880" height="410" fill={`url(#${grid})`} />
      <rect className="map-boundary" x="230" y="65" width="370" height="300" rx="8" />
      <text x="250" y="94" className="map-caption">PATCHRIOT / MANAGED AGENTS</text>
      <rect className="map-tee-boundary" x="655" y="105" width="190" height="180" rx="12" />
      {paths.map((path, index) => <g key={path}><path className={`map-link link-${index % 2}`} d={path} />{!stopped && <rect x="-3" y="-3" width="6" height="6" className="map-packet"><animateMotion dur={`${4 + index % 3}s`} begin={`${-index * .7}s`} repeatCount="indefinite" path={path} /></rect>}</g>)}
      {[{x:110,title:'YOUR WEB APP',detail:'VERIFIED SCOPE'}, {x:300,title:'DISPATCHER',detail:'PERMISSION + QUEUE'}, {x:510,title:'KALI + HERMES',detail:'ISOLATED AGENTS'}, {x:750,title:'NEAR AI',detail:'PRIVATE TEE'}].map(({x,title,detail},i) => <g key={title} transform={`translate(${x},200)`}>
        {i===2 && <><rect className="map-isolation" x="-46" y="-45" width="92" height="88" rx="6" /><rect className="map-node node-1" x="-13" y="-35" width="48" height="48" /></>}
        <rect className={`map-node node-${i%2}`} x="-24" y="-24" width="48" height="48" /><path className="map-face" d={i===3?'M-9 0v-7a9 9 0 0 1 18 0v7M-12 0h24v14h-24Z':'M-8-3h4m8 0h4M-6 6H6'} />
        <text className="node-label" y="-60" textAnchor="middle">{title}</text><text className="node-label" y="62" textAnchor="middle">{detail}</text>
      </g>)}
      <text className="map-caption" x="405" y="350" textAnchor="middle">PRIVATE REPORT + EVIDENCE</text>
      <text className="node-label" x="750" y="320" textAnchor="middle">ENCRYPTED REQUEST</text><text className="node-label" x="750" y="343" textAnchor="middle">VERIFIED RESPONSE</text>
    </svg>
    <ol className="map-key"><li><strong>1. Your web app</strong><span>Exact domain. Your permission.</span></li><li><strong>2. Dispatcher</strong><span>Sets the scope and queues work.</span></li><li><strong>3. Isolated Hermes agents</strong><span>Investigate, reproduce, review.</span></li><li><strong>4. NEAR AI</strong><span>Private model inference.</span></li></ol>
    <p className="flow-caption">Model inference is protected by NEAR’s TEE. Agent hosts and report storage are separate. The animation explains the route; it is not live activity.</p>
    {paused===undefined && <button type="button" className="quiet map-motion" aria-pressed={stopped} onClick={() => setLocalPaused(!stopped)}>{stopped?'Play diagram':'Pause diagram'}</button>}
  </div>;
}
