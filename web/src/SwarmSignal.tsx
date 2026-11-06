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

/** The same source SVG is embedded in the website, docs and repository README. */
export function CoordinationMap({ paused }: { privateSwarm?: boolean; paused?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    const update = () => setPlaying(visible && !document.hidden && !media.matches);
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); });
    if (root.current) observer.observe(root.current);
    media.addEventListener('change', update); document.addEventListener('visibilitychange', update);
    return () => { observer.disconnect(); media.removeEventListener('change', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  const stopped = paused === true || !playing;
  const paths = ['M148 200V260', 'M255 325H320', 'M500 325H530', 'M710 325H740', 'M920 325H955'];
  const packets = stopped ? '' : paths.map((path, i) => `<circle r="3" fill="#ffac9b"><animateMotion dur="4s" begin="${-i * .7}s" repeatCount="indefinite" path="${path}" /></circle>`).join('');
  // Only repository-owned SVG and fixed decorative paths are injected here.
  const drawing = architectureSvg.replace(/<\/svg>\s*$/, `${packets}</svg>`);
  return <div ref={root} className="service-map architecture-map" data-paused={stopped} aria-label="From your verified domain to a private security report">
    <div className="flow-permission"><span>YOU START HERE</span><strong>Verify your domain</strong><span aria-hidden="true">→</span><strong>Confirm access</strong></div>
    <div className="architecture-scroll" tabIndex={0} aria-label="Assessment architecture diagram" dangerouslySetInnerHTML={{ __html: drawing }} />
    <span className="architecture-scroll-hint">Scroll the diagram sideways to explore all agents and providers →</span>
    <ol className="map-key"><li><strong>1. Your web app</strong><span>Exact domain. Your permission.</span></li><li><strong>2. Dispatcher</strong><span>Sets the scope and queues work.</span></li><li><strong>3. Isolated Hermes agents</strong><span>Scout → Recon → Verifier if needed.</span></li><li><strong>4. Inference</strong><span>NEAR · VERIFIED TEE<br />VENICE · API ROUTE</span></li></ol>
    <p className="flow-caption">Provider order and optional fallback are shown at checkout. This diagram explains supported routes, not live activity. <a href={architectureUrl} target="_blank" rel="noreferrer">Open full diagram ↗</a></p>
  </div>;
}
