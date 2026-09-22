export function Icon({ name, size = 18, className = '' }: { name: 'refresh' | 'settings' | 'bell' | 'search' | 'close' | 'chevron' | 'source' | 'download' | 'external' | 'check' | 'warning' | 'star' | 'server' | 'arrow'; size?: number; className?: string }) {
  const paths: Record<typeof name, React.ReactNode> = {
    refresh: <><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.2 7a7 7 0 0 1 11.6-1L20 9M4 15l2.2 3A7 7 0 0 0 18 17"/></>,
    settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/></>,
    bell: <><path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3Z"/><path d="M10 21h4M12 2v2"/></>,
    search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    chevron: <path d="m9 5 7 7-7 7"/>,
    source: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-16-2 20"/></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/></>,
    external: <><path d="M14 3h7v7m0-7L10 14"/><path d="M10 4H4v16h16v-6"/></>,
    check: <path d="m4 12 5 5L20 6"/>,
    warning: <><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v.1"/></>,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>,
    server: <><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.1M7 17.5h.1M12 6.5h5M12 17.5h5"/></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{paths[name]}</svg>;
}
