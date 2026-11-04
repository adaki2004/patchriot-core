import { useEffect, useId, useRef } from 'react';
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
  'M110 190 L290 190', 'M290 190 L480 190', 'M480 190 L680 190',
  'M680 215 L480 215', 'M480 235 L480 310 L290 310 L290 235',
];

/** Same data path for both deployments. The TEE boundary covers only model inference. */
export function CoordinationMap({ privateSwarm, paused }: { privateSwarm: boolean; paused: boolean }) {
  const grid = useId();
  const nodes = [
    { x: 110, title: 'YOUR WEB APP', detail: 'VERIFIED SCOPE' },
    { x: 290, title: 'DISPATCHER', detail: 'PERMISSION + QUEUE' },
    { x: 480, title: 'KALI + HERMES', detail: 'ISOLATED TOOLS' },
    { x: 680, title: 'NEAR AI', detail: 'PRIVATE TEE' },
  ];
  return <svg className={`coordination-map ${privateSwarm ? 'private-map' : 'public-map'}`} viewBox="0 0 800 400" aria-hidden="true">
    <defs><pattern id={grid} width="25" height="25" patternUnits="userSpaceOnUse"><path d="M25 0H0V25" fill="none" stroke="currentColor" strokeOpacity=".09" /></pattern></defs>
    <rect width="800" height="400" fill={`url(#${grid})`} />
    <rect className="map-boundary" x="35" y="105" width="535" height="250" />
    <text x="55" y="130" className="map-caption">{privateSwarm ? 'DEDICATED BUSINESS INSTALLATION' : 'PATCHRIOT MANAGED SERVICE'}</text>
    <rect className="map-tee-boundary" x="605" y="105" width="150" height="180" rx="12" />
    {paths.map((path, index) => <g key={path}><path className={`map-link link-${index % 2}`} d={path} />{!paused && <rect x="-3" y="-3" width="6" height="6" className="map-packet"><animateMotion dur={`${4 + index % 3}s`} begin={`${-index * .7}s`} repeatCount="indefinite" path={path} /></rect>}</g>)}
    {nodes.map(({ x, title, detail }, index) => <g key={title} transform={`translate(${x},200)`}><rect className={`map-node node-${index % 2}`} x="-24" y="-24" width="48" height="48" /><path className="map-face" d={index === 3 ? 'M-9 0v-7a9 9 0 0 1 18 0v7M-12 0h24v14h-24Z' : 'M-8-3h4m8 0h4M-6 6H6'} /><text className="node-label" y="-43" textAnchor="middle">{title}</text><text className="node-label" y="51" textAnchor="middle">{detail}</text></g>)}
    <text className="map-caption" x="387" y="337" textAnchor="middle">PRIVATE REPORT + RECORDED EVIDENCE</text>
    <text className="node-label" x="680" y="315" textAnchor="middle">ENCRYPTED INPUT</text><text className="node-label" x="680" y="337" textAnchor="middle">VERIFIED RESPONSE</text>
    <text className="map-caption" x="55" y="383">MODEL INFERENCE IS ATTESTED · AGENT HOSTS ARE SEPARATE</text>
  </svg>;
}

/** The same infrastructure, operated by Patchriot or by the customer's own team. */
export function NetworkDeployments({ publicAction, privateAction }: { publicAction?: ReactNode; privateAction?: ReactNode }) {
  return <div className="review-blueprint blueprint-deployments" aria-label="Managed service and dedicated installations">
    {[
      { name: 'For your web application', tag: 'MANAGED SERVICE', description: 'You bring the URL. We operate the testing agents.', owner: 'Patchriot manages the work', agents: 'Kali + Hermes · NEAR AI inference', note: 'Verify your domain, confirm access and start. Findings stay private. Public agents cannot join this service.', action: publicAction },
      { name: 'For your business', tag: 'DEDICATED / BY ARRANGEMENT', description: 'A separate installation with agreed access and infrastructure.', owner: 'A dispatcher dedicated to your organization', agents: 'Separate agents and report storage', note: 'We help deploy and configure your setup. Discuss hosting, operator access and the model route with us before sharing data.', action: privateAction },
    ].map(item => <section key={item.name}><span>{item.tag}</span><h4>{item.name}</h4><p className="deployment-description">{item.description}</p><div className="deployment-node"><UIIcon name="grid" /><strong>{item.owner}</strong></div><small>↕ SCOPED ASSIGNMENTS</small><div className="deployment-node"><UIIcon name="agent" /><strong>{item.agents}</strong></div><p>{item.note}</p>{item.action && <footer>{item.action}</footer>}</section>)}
  </div>;
}
