import { useEffect, useRef, useState } from 'react';
import architectureSvg from './assets/assessment-architecture.svg?raw';
import architectureUrl from './assets/assessment-architecture.svg?url';

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

/** Wide screens share the README drawing; narrow screens keep the same flow readable. */
export function CoordinationMap({ paused }: { privateSwarm?: boolean; paused?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    const update = () => { const wide = root.current?.querySelector('.architecture-wide'); setPlaying(visible && !document.hidden && !media.matches && !!wide && getComputedStyle(wide).display !== 'none'); };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); });
    const resize = new ResizeObserver(update);
    if (root.current) { observer.observe(root.current); resize.observe(root.current); }
    media.addEventListener('change', update); document.addEventListener('visibilitychange', update);
    return () => { observer.disconnect(); resize.disconnect(); media.removeEventListener('change', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  const stopped = paused === true || !playing;
  const paths = ['M225 320H285', 'M505 320H550V165H605', 'M505 320H605', 'M865 320H950', 'M395 385V535'];
  const packets = stopped ? '' : paths.map((path, i) => `<circle r="3" fill="#ffac9b"><animateMotion dur="4s" begin="${-i * .7}s" repeatCount="indefinite" path="${path}" /></circle>`).join('');
  // Only repository-owned SVG and fixed decorative paths are injected here.
  const drawing = architectureSvg.replace(/<\/svg>\s*$/, `${packets}</svg>`);
  return <div ref={root} className="service-map architecture-map" data-paused={stopped} aria-label="From your verified domain to a private security report">
    <div className="flow-permission"><span>YOU START HERE</span><strong>Verify your domain</strong><span aria-hidden="true">→</span><strong>Confirm access</strong></div>
    <div className="architecture-wide" aria-label="Assessment architecture diagram" dangerouslySetInnerHTML={{ __html: drawing }} />
    <div className="architecture-vertical" role="group" aria-label="Assessment architecture diagram">
      <div className="architecture-box"><strong>Your web app</strong><span>Verified domain and approved scope</span></div>
      <div className="architecture-link" aria-hidden="true">↕</div>
      <section className="architecture-core" aria-label="Patchriot Core"><h3>Core</h3><p>Your account · access · checkout</p><div className="architecture-box architecture-dispatcher"><strong>Dispatcher</strong><span>Permission, scheduling and evidence</span><small>Ready roles go to eligible free workers</small></div></section>
      <div className="architecture-link" aria-hidden="true">↓</div>
      <section className="architecture-contributors" aria-label="Inference contributors">
        <h3>Inference contributors</h3>
        <div className="architecture-agents">{['1', '2', '…', 'N'].map(number => number === '…' ? <div className="architecture-more" key={number} aria-hidden="true">⋮</div> : <div className="architecture-box" key={number}><strong>Agent {number}</strong><span>Kali Linux® · Hermes · scoped relay</span></div>)}</div>
        <div className="architecture-models"><h4>Approved model routes</h4><div><img src="/brand/near-ai.svg" alt="NEAR AI" width="150" height="29" /><span>Verified TEE inference</span></div><div><img src="/brand/venice.svg" alt="Venice" width="130" height="59" /><span>API inference</span></div></div>
      </section>
      <div className="architecture-link"><span>Evidence returns through the dispatcher</span><span aria-hidden="true">↓</span></div>
      <div className="architecture-box"><strong>Your private report</strong><span>Findings, request evidence and coverage gaps</span></div>
    </div>
    <p className="flow-caption">The numbered agents are inference contributors, not fixed review roles. Patchriot operates them today; public contribution is coming soon. Provider order and optional fallback are shown at checkout. This illustrates the architecture, not live activity. <a href={architectureUrl} target="_blank" rel="noreferrer">Open full diagram ↗</a></p>
  </div>;
}
