import { useEffect, useRef } from 'react';
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

/** Managed and dedicated installations use this same permission and evidence flow. */
export function CoordinationMap({ paused }: { privateSwarm?: boolean; paused: boolean }) {
  const nodes = [
    { icon: 'grid' as const, title: 'Patchriot core', detail: 'Your account, scope and payment', number: '01' },
    { icon: 'clock' as const, title: 'Dispatcher', detail: 'Approved work, queue and limits', number: '02' },
    { icon: 'agent' as const, title: 'Kali + Hermes', detail: '1 … N isolated agents', number: '03' },
    { icon: 'lock' as const, title: 'NEAR AI', detail: 'Private TEE inference', number: '04' },
  ];
  return <div className="service-map" data-paused={paused} aria-label="From your verified domain to a private security report">
    <div className="flow-permission"><span>YOU START HERE</span><strong>Verify your domain</strong><span aria-hidden="true">→</span><strong>Confirm access</strong></div>
    <ol className="flow-nodes">{nodes.map(node => <li key={node.number} className="flow-node"><div className="flow-node-top"><span>{node.number}</span><UIIcon name={node.icon} /></div><h3>{node.title}</h3><p>{node.detail}</p>{node.number === '03' && <div className="flow-agent-stack" aria-hidden="true"><i /><i /><i /><span>… N</span></div>}{node.number === '04' && <small>Encrypted request · verified response</small>}</li>)}</ol>
    <div className="flow-return"><span aria-hidden="true">↶</span><strong>Private findings return to your console.</strong><span>Recorded requests. Clear next steps.</span></div>
    <p className="flow-caption">Same architecture. Operated by Patchriot, or a dedicated installation for your business.</p>
  </div>;
}
