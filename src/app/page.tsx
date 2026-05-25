export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 720 }}>
      <h1>AITP Control Plane</h1>
      <p>Monitoring, registry, and audit for AITP agent deployments.</p>
      <h2>Endpoints</h2>
      <ul>
        <li><code>GET /.well-known/aitp-manifest</code></li>
        <li><code>GET /.well-known/aitp-revocation-list</code></li>
        <li><code>GET /api/health</code></li>
        <li><code>GET /api/registry/agents</code></li>
        <li><code>POST /api/registry/enroll</code></li>
        <li><code>POST /api/registry/agents</code> (enrollment token)</li>
        <li><code>POST /api/events</code></li>
        <li><code>GET /api/events/stream</code> (SSE)</li>
        <li><code>GET /api/dashboard/overview</code></li>
      </ul>
    </main>
  );
}
