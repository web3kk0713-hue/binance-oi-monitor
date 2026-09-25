import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './metricHelp.css';

export function metricHelpPosition(anchor: Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'>,
  bubble: Pick<DOMRect, 'width' | 'height'>, viewport: { width: number; height: number }) {
  const left = Math.max(12, Math.min(anchor.left + anchor.width / 2 - bubble.width / 2, viewport.width - bubble.width - 12));
  const below = anchor.bottom + 8;
  const top = Math.max(12, Math.min(below + bubble.height <= viewport.height - 12 ? below : anchor.top - bubble.height - 8,
    viewport.height - bubble.height - 12));
  return { left, top };
}

/** Compact metric help shared by mouse, keyboard, and touch users. No market state or requests. */
export function MetricHelp({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12, ready: false });
  function cancelClose() { if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = null; }
  function close() { cancelClose(); pinned.current = false; setOpen(false); }
  function leave() {
    cancelClose();
    if (!pinned.current) closeTimer.current = setTimeout(() => {
      if (document.activeElement !== trigger.current) setOpen(false);
    }, 100);
  }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const anchor = trigger.current?.getBoundingClientRect();
      const bubble = tooltip.current?.getBoundingClientRect();
      if (!anchor || !bubble) return;
      setPosition({ ...metricHelpPosition(anchor, bubble, { width: window.innerWidth, height: window.innerHeight }), ready: true });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, children]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !tooltip.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <span className="metric-help"><button ref={trigger} type="button" className="metric-help-trigger"
    aria-label={`${label}说明`} aria-describedby={open ? id : undefined} aria-expanded={open}
    onPointerEnter={event => { if (event.pointerType !== 'touch') { cancelClose(); setOpen(true); } }}
    onPointerLeave={leave} onFocus={() => { cancelClose(); setOpen(true); }}
    onBlur={close}
    onClick={event => { event.preventDefault(); event.stopPropagation(); cancelClose(); pinned.current = !pinned.current; setOpen(pinned.current); }}
  ><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 4.5v.3"/></svg></button>
    {open && typeof document !== 'undefined' ? createPortal(<div ref={tooltip} id={id} role="tooltip" className="metric-help-bubble"
      style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }}
      onPointerEnter={cancelClose} onPointerLeave={leave}><strong>{label}</strong><div>{children}</div></div>, document.body) : null}
  </span>;
}
