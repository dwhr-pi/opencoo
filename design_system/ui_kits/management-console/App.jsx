const { useState: useS } = React;

function DashboardPage() {
  return (
    <div style={{ padding:'24px 28px', display:'flex', flexDirection:'column', gap:20 }}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12 }}>
        {[
          ['4', 'domains'],
          ['17', 'active bindings'],
          ['124', 'pages compiled · 7d'],
          ['2', 'open contradictions'],
        ].map(([v, l]) => (
          <div key={l} style={{ border:'1px solid var(--rule)', borderRadius:6, background:'var(--paper)', padding:'14px 16px' }}>
            <div style={{ fontFamily:'var(--font-sans)', fontSize:28, fontWeight:500, letterSpacing:'-.01em' }}>{v}</div>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--ink-3)', letterSpacing:'.08em', textTransform:'uppercase' }}>{l}</div>
          </div>
        ))}
      </div>
      <HeartbeatCard
        audience="ceo · heartbeat"
        title='"Pricing-2026Q2 shipped; two open contradictions sit under it."'
        body="Pricing page re-compiled this morning after three Fireflies transcripts landed. Two contradictions remain: handbook says Net-30, sales deck says Net-45."
        meta="mon 08:00 · run r_9e4a21"
      />
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <WikiPeek path="wiki-executive / processes / pricing-2026q2.md">
          <b style={{ color:'var(--ink)', fontWeight:500 }}>Identity &amp; purpose.</b> Sets 2026 Q2 list pricing across Growth &amp; Scale tiers. <Badge tone="alert">contradiction</Badge> Handbook says Net-30; commercial deck says Net-45.
        </WikiPeek>
        <div style={{ border:'1px solid var(--rule)', borderRadius:6, background:'var(--paper)', padding:'14px 16px' }}>
          <div style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--ink-3)', letterSpacing:'.08em', textTransform:'uppercase', marginBottom:10 }}>recent log</div>
          <div style={{ fontFamily:'var(--font-mono)', fontSize:11.5, lineHeight:1.7, color:'var(--ink-2)' }}>
            <div><span style={{ color:'var(--ink-3)' }}>08:14</span> compile processes/pricing-2026q2.md (+124w)</div>
            <div><span style={{ color:'var(--ink-3)' }}>08:14</span> index rebuilt · 3 pages touched</div>
            <div><span style={{ color:'var(--ink-3)' }}>08:19</span> <span style={{ color:'oklch(0.62 0.17 25)' }}>guard</span> injection score 0.87 → review</div>
            <div><span style={{ color:'var(--ink-3)' }}>08:22</span> chat mcp · 4 pages read</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewPage() {
  const [items, setItems] = useS([
    { id:1, title:'Compiled draft · processes/onboarding-2026.md', source:'source: notion / handbook · 3 pages affected', tone:'neutral' },
    { id:2, title:'Surfacer candidate · auto-sync sales-deck updates to pricing page', source:'from: wiki-sales/deck.md · estimated complexity: low', tone:'adv' },
    { id:3, title:'Guard flag · possible prompt injection in Fireflies transcript', source:'source: fireflies / board-2026-04-18 · jailbreak=0.87', tone:'alert' },
    { id:4, title:'Compiled draft · processes/pricing-2026q2.md', source:'source: fireflies / board-2026-04-18', tone:'neutral' },
  ]);
  const [approved, setApproved] = useS({});
  return (
    <div style={{ padding:'24px 28px', display:'flex', flexDirection:'column', gap:16 }}>
      <div style={{ display:'flex', alignItems:'baseline', gap:14 }}>
        <h2 style={{ margin:0, fontFamily:'var(--font-sans)', fontWeight:500, fontSize:22 }}>Review queue</h2>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--ink-3)', letterSpacing:'.06em', textTransform:'uppercase' }}>{items.filter(i => !approved[i.id]).length} open · {Object.keys(approved).length} approved today</span>
      </div>
      <div style={{ border:'1px solid var(--rule)', borderRadius:6, background:'var(--paper)' }}>
        <div style={{ padding:'10px 16px', fontFamily:'var(--font-mono)', fontSize:10, color:'var(--ink-3)', letterSpacing:'.08em', textTransform:'uppercase', background:'var(--paper-2)', borderBottom:'1px solid var(--rule)', borderTopLeftRadius:6, borderTopRightRadius:6 }}>
          type · item · action
        </div>
        {items.map(it => (
          <ReviewRow key={it.id} {...it}
            approved={approved[it.id]}
            onApprove={() => setApproved(a => ({ ...a, [it.id]: true }))}
            onReject={() => setItems(xs => xs.filter(x => x.id !== it.id))}/>
        ))}
      </div>
    </div>
  );
}

function SourcesPage() {
  return (
    <div style={{ padding:'24px 28px', display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ display:'flex', alignItems:'baseline', gap:14 }}>
        <h2 style={{ margin:0, fontFamily:'var(--font-sans)', fontWeight:500, fontSize:22 }}>Sources</h2>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--ink-3)', letterSpacing:'.06em', textTransform:'uppercase' }}>17 bindings</span>
        <div style={{ marginLeft:'auto' }}><Btn variant="primary">+ Add binding</Btn></div>
      </div>
      <div style={{ border:'1px solid var(--rule)', borderRadius:6, background:'var(--paper)' }}>
        <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr 1.2fr 1fr auto', gap:16, padding:'10px 16px', fontFamily:'var(--font-mono)', fontSize:10, color:'var(--ink-3)', letterSpacing:'.08em', textTransform:'uppercase', background:'var(--paper-2)', borderBottom:'1px solid var(--rule)', borderTopLeftRadius:6, borderTopRightRadius:6 }}>
          <span>binding</span><span>type</span><span>domain</span><span>review mode</span><span>status</span>
        </div>
        <SourceRow name="gdrive / executive" type="filesystem" domain="wiki-executive" mode="auto" status="ok"/>
        <SourceRow name="notion / handbook"   type="filesystem" domain="wiki-hr" mode="approve" status="ok"/>
        <SourceRow name="fireflies / board"   type="transcription" domain="wiki-executive" mode="approve" status="alert"/>
        <SourceRow name="asana / ops"         type="project_mgmt" domain="wiki-ops" mode="auto" status="ok"/>
        <SourceRow name="linear / engineering" type="project_mgmt" domain="wiki-eng" mode="auto" status="paused"/>
      </div>
    </div>
  );
}

function AgentsPage() {
  return (
    <div style={{ padding:'24px 28px', display:'flex', flexDirection:'column', gap:16 }}>
      <h2 style={{ margin:0, fontFamily:'var(--font-sans)', fontWeight:500, fontSize:22 }}>Agents</h2>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
        {[
          { name:'ceo-heartbeat', def:'heartbeat', dom:'wiki-executive · company', sch:'weekdays 08:00', out:'slack/#ceo', tone:'adv' },
          { name:'ops-heartbeat', def:'heartbeat', dom:'wiki-ops', sch:'daily 09:00', out:'slack/#ops', tone:'adv' },
          { name:'lint-exec',     def:'lint',      dom:'wiki-executive', sch:'mon 07:00', out:'review queue', tone:'neutral' },
          { name:'chat-mcp',      def:'chat',      dom:'all · scoped by token', sch:'on-demand', out:'mcp', tone:'wiki' },
        ].map(a => (
          <div key={a.name} style={{ border:'1px solid var(--rule)', borderRadius:6, background:'var(--paper)', padding:'14px 16px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
              <Badge tone={a.tone}>{a.def}</Badge>
              <span style={{ fontFamily:'var(--font-mono)', fontSize:13 }}>{a.name}</span>
            </div>
            <div style={{ fontSize:12.5, color:'var(--ink-2)', lineHeight:1.6 }}>
              <div><span style={{ color:'var(--ink-3)' }}>grounds </span>{a.dom}</div>
              <div><span style={{ color:'var(--ink-3)' }}>schedule </span>{a.sch}</div>
              <div><span style={{ color:'var(--ink-3)' }}>outputs </span>{a.out}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Placeholder({ label }) {
  return <div style={{ padding:60, textAlign:'center', fontFamily:'var(--font-mono)', fontSize:12, color:'var(--ink-3)', letterSpacing:'.06em', textTransform:'uppercase' }}>— {label} —</div>;
}

function App() {
  const [page, setPage] = useS('dashboard');
  const titles = { dashboard:'Dashboard', heartbeat:'Heartbeat feed', review:'Review queue', sources:'Sources', agents:'Agents', domains:'Domains', log:'Execution log' };
  const content = {
    dashboard: <DashboardPage/>, heartbeat: <DashboardPage/>,
    review: <ReviewPage/>, sources: <SourcesPage/>, agents: <AgentsPage/>,
    domains: <Placeholder label="domains · coming soon"/>,
    log: <Placeholder label="execution log · coming soon"/>,
  }[page];
  return (
    <div style={{ height:'100vh', display:'flex', background:'var(--paper)' }}>
      <Sidebar page={page} setPage={setPage}/>
      <main style={{ flex:1, display:'flex', flexDirection:'column', overflow:'auto' }}>
        <TopBar title={titles[page]}/>
        {content}
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
