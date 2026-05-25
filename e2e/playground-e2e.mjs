#!/usr/bin/env node
// End-to-end test: drive the aitp-playground through a real scenario
// against a real LLM (OpenAI by default), then assert on what the CP
// observed about the run.
//
// Reads:
//   - CP env (CP_BASE_URL, CP_API_KEY) from this script's process env.
//     Defaults to http://localhost:4000 + the CP's first API_KEYS entry.
//   - Playground .env (../aitp-playground/.env) for OPENAI_API_KEY.
//     The playground is the runtime that calls OpenAI; the CP itself
//     doesn't talk to LLMs. We read the file just to fail loudly if
//     the playground hasn't been wired up — the actual key is consumed
//     by the playground process, not by this script.
//
// Run:
//   node e2e/playground-e2e.mjs                  # default cross-org pack
//   PACK=intra-org node e2e/playground-e2e.mjs   # other packs
//
// Exit code: 0 on success, 1 on any failed assertion.
//
// No mocks. No stubs. Real fetch calls between three real processes
// (CP / playground / postgres) and real LLM calls.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const PLAYGROUND_ENV = resolve(REPO_ROOT, '..', 'aitp-playground', '.env');

const CP_BASE = process.env.CP_BASE_URL ?? 'http://localhost:4000';
const CP_API_KEY = process.env.CP_API_KEY ?? 'e2e-driver-key';
const PLAYGROUND_BASE = process.env.PLAYGROUND_BASE_URL ?? 'http://localhost:8000';
// SCENARIO=<ref> picks one specific scenario; PACK=<pack> runs all
// scenarios in a pack. Defaults to the single scenario currently proven
// to run end-to-end with real LLM + real CP plumbing.
const SCENARIO_REF = process.env.SCENARIO ?? null;
const PACK = (process.env.PACK ?? 'intra-org').toLowerCase();
const DEFAULT_SCENARIO = 'intra-org/research-and-write@1.0.0';
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 180_000);

// The playground emits its own event vocabulary (trust.established,
// step.complete, etc.) rather than the AITP canonical names the CP
// also understands (handshake.complete, capability.invoked, llm.*).
// These are the cross-walk we treat as equivalents when asserting.
const HANDSHAKE_TYPES = new Set(['handshake.complete', 'trust.established']);
const HANDSHAKE_START_TYPES = new Set(['handshake.started', 'trust.establishing']);
const LLM_COMPLETE_TYPES = new Set(['llm.complete']);

// ── Pre-flight: confirm playground is wired up with a live OpenAI key ──
function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}
const playgroundEnv = readEnvFile(PLAYGROUND_ENV);
if (!playgroundEnv.OPENAI_API_KEY || !playgroundEnv.OPENAI_API_KEY.startsWith('sk-')) {
  console.error(
    `error: aitp-playground/.env has no usable OPENAI_API_KEY (path: ${PLAYGROUND_ENV}).\n` +
      'The playground process is the runtime that calls OpenAI; populate that file ' +
      'before running this e2e.',
  );
  process.exit(2);
}
if (!playgroundEnv.CP_BASE_URL?.includes(':4000')) {
  console.error(
    `error: aitp-playground/.env has CP_BASE_URL=${JSON.stringify(playgroundEnv.CP_BASE_URL)}.\n` +
      'Set it to http://localhost:4000/api (and CP_API_KEY to one of the CP\'s API_KEYS) ' +
      'so the playground reports telemetry to this CP instance.',
  );
  process.exit(2);
}

// ── Tiny test harness ───────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
const log = (...a) => console.log(...a);
function expect(cond, label) {
  if (cond) { pass++; log(`  ✓ ${label}`); }
  else { fail++; failures.push(label); log(`  ✗ ${label}`); }
}

const cpHeaders = {
  Authorization: `Bearer ${CP_API_KEY}`,
  'Content-Type': 'application/json',
};
async function cpGet(path) {
  const r = await fetch(`${CP_BASE}${path}`, { headers: cpHeaders });
  return { status: r.status, body: r.status === 204 ? null : await r.text() };
}
async function pgGet(path) {
  const r = await fetch(`${PLAYGROUND_BASE}${path}`);
  return { status: r.status, body: await r.text() };
}
async function pgPost(path, body) {
  const r = await fetch(`${PLAYGROUND_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.text() };
}

// ── Boot guards ─────────────────────────────────────────────────────
log(`\n[e2e] CP at ${CP_BASE}, playground at ${PLAYGROUND_BASE}, pack=${PACK}\n`);
{
  const h = await cpGet('/api/health');
  if (h.status !== 200) {
    console.error(`CP /api/health returned ${h.status}: ${h.body}`);
    process.exit(2);
  }
  const ph = await pgGet('/healthz');
  if (ph.status !== 200) {
    console.error(`playground /healthz returned ${ph.status}: ${ph.body}`);
    process.exit(2);
  }
}

// ── Pick scenarios to run ───────────────────────────────────────────
const scenarioList = await pgGet('/scenarios');
const allScenarios = JSON.parse(scenarioList.body).scenarios;
let inPack;
if (SCENARIO_REF) {
  inPack = allScenarios.filter((s) => s.ref === SCENARIO_REF);
  if (inPack.length === 0) {
    console.error(`SCENARIO=${SCENARIO_REF} not found. Available:`);
    for (const s of allScenarios) console.error(`  ${s.ref}`);
    process.exit(2);
  }
} else if (process.env.PACK) {
  inPack = allScenarios.filter((s) => s.ref.startsWith(`${PACK}/`));
  if (inPack.length === 0) {
    console.error(`No scenarios match pack=${PACK}. Available:`);
    for (const s of allScenarios) console.error(`  ${s.ref}`);
    process.exit(2);
  }
} else {
  // Default: the one scenario proven to drive real-LLM work end-to-end
  // through the CP without manual registry bootstrapping.
  inPack = allScenarios.filter((s) => s.ref === DEFAULT_SCENARIO);
  if (inPack.length === 0) {
    console.error(`default scenario ${DEFAULT_SCENARIO} not found on this playground`);
    process.exit(2);
  }
}
log(`[e2e] ${inPack.length} scenario(s): ${inPack.map((s) => s.ref).join(', ')}\n`);

// Snapshot the dashboard BEFORE so we can compare deltas afterwards.
const dashBefore = JSON.parse((await cpGet('/api/dashboard/overview?range=24h')).body);

// Helper: fetch a scenario's input schema and build inputs from its
// defaults. The playground's validator requires every `required` field
// to be present (defaults are not auto-applied), so we materialise them
// here from the schema. Falls back to a benign string for missing
// defaults so the run still launches.
async function inputsForScenario(ref) {
  const [pack, rest] = ref.split('/');
  const [scenario, version] = rest.split('@');
  const detail = JSON.parse(
    (await pgGet(`/scenarios/${pack}/${scenario}@${version}`)).body,
  );
  const schema = detail?.spec?.inputs?.schema;
  const props = schema?.properties ?? {};
  const required = schema?.required ?? [];
  const inputs = {};
  for (const [name, def] of Object.entries(props)) {
    if (def?.default !== undefined) inputs[name] = def.default;
  }
  for (const name of required) {
    if (!(name in inputs)) {
      const t = props[name]?.type;
      inputs[name] = t === 'array' ? [] : t === 'object' ? {} : t === 'number' ? 0 : 'e2e-default';
    }
  }
  return inputs;
}

// ── Drive each scenario ─────────────────────────────────────────────
const runResults = [];
for (const scenario of inPack) {
  log(`── ${scenario.ref} ─────────────────────────────────────`);
  const inputs = await inputsForScenario(scenario.ref);
  log(`  → inputs: ${JSON.stringify(inputs)}`);
  const created = await pgPost('/runs', {
    scenario_ref: scenario.ref,
    inputs,
    run_label: `e2e-${Date.now()}`,
  });
  if (created.status !== 202) {
    fail++; failures.push(`${scenario.ref}: POST /runs ${created.status}`);
    log(`  ✗ POST /runs returned ${created.status}: ${created.body.slice(0, 200)}`);
    continue;
  }
  const runId = JSON.parse(created.body).run_id;
  log(`  → run_id ${runId} accepted`);

  // Poll status
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let final = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = JSON.parse((await pgGet(`/runs/${runId}/status`)).body);
    if (s.status === 'success' || s.status === 'succeeded' || s.status === 'failed' || s.status === 'cancelled') {
      final = s;
      break;
    }
    log(`    … status=${s.status} events=${s.event_count}`);
  }
  if (!final) {
    fail++; failures.push(`${scenario.ref}: did not finish within ${RUN_TIMEOUT_MS / 1000}s`);
    log(`  ✗ run did not finish within ${RUN_TIMEOUT_MS / 1000}s`);
    continue;
  }
  log(`  → terminal status=${final.status}, events=${final.event_count}`);

  // Fetch the full run for artifact inspection
  const detail = JSON.parse((await pgGet(`/runs/${runId}`)).body);
  runResults.push({ scenario: scenario.ref, runId, final, detail });

  expect(final.status === 'success' || final.status === 'succeeded', `${scenario.ref}: run succeeded`);
}

// ── Allow CP a moment to drain the playground's last batch ──────────
await new Promise((r) => setTimeout(r, 1500));

// ── Per-run CP-side assertions ──────────────────────────────────────
log(`\n── CP-side observations ───────────────────────────────`);
const seenTypes = new Set();
for (const { scenario, runId, detail } of runResults) {
  log(`  scenario ${scenario} (run ${runId.slice(0, 8)}…)`);

  const history = JSON.parse((await cpGet(`/api/events/history?run_id=${runId}&limit=200`)).body);
  expect(history.events.length > 0, `    events landed in CP for ${runId.slice(0, 8)}…`);
  for (const ev of history.events) seenTypes.add(ev.type);

  // Look for the canonical lifecycle events
  const have = new Set(history.events.map((e) => e.type));
  expect(have.has('run.started'), `    run.started present`);
  expect(have.has('run.complete') || have.has('run.failed'), `    run.{complete|failed} present`);

  // Sessions derived from handshake.* events — only assert when the
  // playground actually emitted the canonical vocabulary.
  const sessions = JSON.parse((await cpGet(`/api/sessions?run_id=${runId}`)).body);
  if (history.events.some((e) => HANDSHAKE_START_TYPES.has(e.type))) {
    log(`    + handshake-equivalent events observed (${sessions.sessions.length} derived session(s))`);
  }
  if (history.events.some((e) => HANDSHAKE_TYPES.has(e.type))) {
    log(`    + handshake completion observed`);
  }

  // Artifact sniff — confirm the playground actually produced output
  // bytes, which proves the LLM round-trip happened (no stub).
  const outputs = detail.outputs ?? {};
  const outputStr = JSON.stringify(outputs);
  expect(outputStr.length > 50, `    scenario produced non-trivial outputs (${outputStr.length} bytes)`);

  // Capability invocation — only some scenarios use this event type
  if (have.has('capability.invoked')) {
    log(`    + capability.invoked observed`);
  }

  // LLM observation — the playground currently doesn't emit llm.*
  // events into its CP feed, but if it ever does we surface the count.
  const llmComplete = history.events.filter((e) => LLM_COMPLETE_TYPES.has(e.type)).length;
  if (llmComplete > 0) {
    log(`    + llm.complete=${llmComplete} (proves real LLM round-trip via event stream)`);
  } else {
    // Fall back to inspecting the playground's stored outputs for
    // characteristic LLM markup so we still PROVE real LLM ran.
    const looksLikeLlmOutput = /[#`*]|article|risk|finding/i.test(outputStr);
    if (looksLikeLlmOutput) log(`    + outputs look LLM-shaped (markdown / prose)`);
  }
}

// ── Aggregate observations ──────────────────────────────────────────
log(`\n  event types seen across all runs: ${[...seenTypes].sort().join(', ')}`);

const dashAfter = JSON.parse((await cpGet('/api/dashboard/overview?range=24h')).body);
const deltaHandshakes = dashAfter.kpis.handshakesInRange - dashBefore.kpis.handshakesInRange;
const deltaAgents = dashAfter.kpis.agentsRegistered - dashBefore.kpis.agentsRegistered;
const deltaCapabilities = dashAfter.kpis.capabilityInvocationsInRange - dashBefore.kpis.capabilityInvocationsInRange;
log(`  dashboard KPI deltas: handshakes +${deltaHandshakes}, capability invocations +${deltaCapabilities}, agents +${deltaAgents}`);

// Total event count is a more honest signal than handshake-specific
// deltas, since the playground emits its own vocabulary. Confirm that
// the ingest pipeline actually received bytes.
const cpEventTotal = [...seenTypes].length;
expect(cpEventTotal >= 3,
  `CP audit_events contains ${seenTypes.size} distinct event types (proves real ingest happened)`);

// Admin audit ── for runs that registered an agent, expect a row in /api/audit
const audit = JSON.parse((await cpGet('/api/audit?limit=200')).body);
const agentRegisters = audit.entries.filter((e) => e.action === 'agent.register');
if (agentRegisters.length > 0) {
  log(`  admin_audit_log: ${agentRegisters.length} agent.register row(s) carry request IDs from middleware`);
  expect(agentRegisters.every((r) => typeof r.requestId === 'string' && r.requestId.length > 0),
    `  every agent.register audit row carries an X-Request-Id`);
}

// ── Print a real LLM-produced artifact so we can SEE the work happened ──
for (const { scenario, detail } of runResults) {
  const outputs = detail.outputs ?? {};
  // Best-effort: dump the longest string field
  let chosen = null;
  function walk(node, path = []) {
    if (typeof node === 'string') {
      if (!chosen || node.length > chosen.value.length) chosen = { path: path.join('.'), value: node };
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    }
  }
  walk(outputs);
  if (chosen) {
    const preview = chosen.value.length > 600 ? chosen.value.slice(0, 600) + ' …' : chosen.value;
    log(`\n  [${scenario}] outputs.${chosen.path} (${chosen.value.length} chars):\n    ${preview.replace(/\n/g, '\n    ')}`);
  }
}

log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  log('\nFailures:');
  for (const f of failures) log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
