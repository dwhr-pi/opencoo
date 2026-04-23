const { useState } = React;

function Sidebar({ page, setPage }) {
  const items = [
    ['dashboard', 'dashboard'],
    ['heartbeat', 'heartbeat'],
    ['review',    'review queue'],
    ['sources',   'sources'],
    ['agents',    'agents'],
    ['domains',   'domains'],
    ['log',       'execution log'],
  ];
  return (
    <nav style={{
      width: 240, background: 'var(--paper-2)', borderRight: '1px solid var(--rule)',
      padding: '22px 16px', display: 'flex', flexDirection: 'column', gap: 2,
      fontFamily: 'var(--font-sans)'
    }}>
      <div style={{ display:'flex', alignItems:'center', gap: 10, padding: '6px 8px 18px', borderBottom: '1px solid var(--rule)', marginBottom: 10 }}>
        <img src="../../assets/logo-trio-coo.svg" height="22" alt="opencoo"/>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: '-0.005em' }}>opencoo</span>
      </div>
      {items.map(([k, label]) => (
        <button key={k} onClick={() => setPage(k)}
          style={{
            textAlign:'left', font: 'inherit', fontSize: 13, padding: '8px 10px',
            background: page === k ? 'var(--paper)' : 'transparent',
            border: '1px solid ' + (page === k ? 'var(--rule)' : 'transparent'),
            borderRadius: 4, color: page === k ? 'var(--ink)' : 'var(--ink-2)',
            cursor: 'pointer',
          }}>
          {label}
        </button>
      ))}
      <div style={{ marginTop:'auto', paddingTop: 12, borderTop: '1px solid var(--rule)', fontFamily:'var(--font-mono)', fontSize: 10, color:'var(--ink-3)', letterSpacing:'.08em', textTransform:'uppercase' }}>
        v0.1 · self-hosted
      </div>
    </nav>
  );
}

function TopBar({ title }) {
  return (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'space-between',
      padding: '14px 24px', borderBottom: '1px solid var(--rule)',
      fontFamily:'var(--font-mono)', fontSize: 11, color:'var(--ink-3)',
      letterSpacing:'.06em', textTransform:'uppercase',
    }}>
      <span><b style={{ color: 'var(--ink)', fontWeight: 500 }}>{title}</b></span>
      <span>mon 08:24 · run r_9e4a21</span>
    </div>
  );
}

function Badge({ tone = 'neutral', children }) {
  const toneMap = {
    neutral: { bg: 'var(--paper-2)', fg: 'var(--ink-2)', br: 'var(--rule)' },
    adv:     { bg: 'color-mix(in oklab, oklch(0.74 0.13 70) 28%, var(--paper))', fg: 'oklch(0.42 0.10 55)', br: 'color-mix(in oklab, oklch(0.74 0.13 70) 40%, var(--paper))' },
    wiki:    { bg: 'color-mix(in oklab, oklch(0.55 0.08 180) 14%, var(--paper))', fg: 'oklch(0.55 0.08 180)', br: 'color-mix(in oklab, oklch(0.55 0.08 180) 25%, var(--paper))' },
    alert:   { bg: 'color-mix(in oklab, oklch(0.62 0.17 25) 14%, var(--paper))', fg: 'oklch(0.62 0.17 25)', br: 'color-mix(in oklab, oklch(0.62 0.17 25) 30%, var(--paper))' },
    ok:      { bg: 'color-mix(in oklab, #1f8a5a 14%, var(--paper))', fg: '#1b6a46', br: 'color-mix(in oklab, #1f8a5a 26%, var(--paper))' },
  };
  const t = toneMap[tone];
  return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, textTransform:'uppercase', letterSpacing:'.08em', padding:'3px 7px', borderRadius: 3, background: t.bg, color: t.fg, border: '1px solid ' + t.br }}>{children}</span>;
}

function Btn({ variant='primary', children, onClick, kbd }) {
  const v = {
    primary: { bg:'var(--ink)', fg:'var(--paper)', br:'var(--ink)' },
    ghost:   { bg:'transparent', fg:'var(--ink)', br:'var(--ink)' },
    adv:     { bg:'oklch(0.74 0.13 70)', fg:'#1b1409', br:'oklch(0.42 0.10 55)' },
    subtle:  { bg:'var(--paper-2)', fg:'var(--ink)', br:'var(--rule)' },
  }[variant];
  return (
    <button onClick={onClick} style={{
      display:'inline-flex', alignItems:'center', gap:8,
      fontFamily:'var(--font-sans)', fontSize: 13, fontWeight: 500,
      padding:'8px 12px', borderRadius: 3,
      border: '1px solid ' + v.br, background: v.bg, color: v.fg,
      cursor:'pointer',
    }}>
      {children}
      {kbd && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, opacity: .65 }}>{kbd}</span>}
    </button>
  );
}

Object.assign(window, { Sidebar, TopBar, Badge, Btn });
