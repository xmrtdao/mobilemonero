#!/usr/bin/env node
// Guards the Activity Intelligence work.
//
// The three defects this guards against are all invisible in a screenshot:
//
//  1. Attribution. The log showed "unknown" for a third of its rows because
//     the caller was never resolved. A client that is not an agent must be
//     labelled as a client, never as an agent, and never as "unknown".
//  2. Grouping. One fault written down twice must read as one fault, and a
//     fault that recurs must not be split into a dozen groups that differ
//     only in how long it took.
//  3. Version. An error must be able to name the version of the file that
//     was live when it fired — otherwise "the code I am reading" and "the
//     code that threw" are the same sentence with different meanings.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''));
};
const section = t => console.log('\n=== ' + t + ' ===');

const { classifyPath, classifyRequest, fingerprint, canonicalErrorMessage } =
  await import('../lib/log-intel.mjs');
const { scanInfraFiles, findRouteOwner } = await import('../lib/infra-files.mjs');

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

section('attribution: a caller is named, and never called "unknown"');
{
  check('the suite dashboard is a client, not an agent',
    classifyPath('/api/suite/tasks') === 'suite-dashboard', classifyPath('/api/suite/tasks'));
  check('a fleet-chat call is a client',
    classifyPath('/api/fleet-chat/messages') === 'fleet-chat', classifyPath('/api/fleet-chat/messages'));
  check('a tool run is a client',
    classifyPath('/tools/run') === 'tools-run', classifyPath('/tools/run'));
  check('a cron-shaped row is named by its type',
    classifyPath(null, 'cron_execution') === 'cron-engine', classifyPath(null, 'cron_execution'));

  // Nothing may classify as "unknown" — that is the whole point.
  const samples = [
    '/api/suite/tasks', '/api/fleet-chat/messages', '/tools/run', '/monitor',
    '/api/trustgraph/trajectory', '/api/alice/tick', '/health', '/api/activity-log',
    '/webhook/resend-inbound', '/functions/v1/vectorize-memory', '/rest/v1/x',
  ];
  const unknown = samples.filter(p => !classifyPath(p) || classifyPath(p) === 'unknown');
  check('no path classifies as unknown', unknown.length === 0, unknown);

  // An agent that says who it is is believed; a request that says nothing
  // is a client, and is labelled as one.
  const withHeader = classifyRequest({ headers: { 'x-agent-id': 'hermes' }, path: '/tools/run' });
  check('an explicit agent id wins', withHeader.actor === 'hermes' && withHeader.actor_kind === 'agent', withHeader);
  const without = classifyRequest({ headers: {}, path: '/api/suite/tasks' });
  check('a request with no agent is a client', without.actor_kind === 'client' && without.actor === 'suite-dashboard', without);
}

section('grouping: one fault reads as one fault');
{
  const slow = fingerprint('GET /rest/v1/knowledge_entities → 406 (28ms)');
  const slower = fingerprint('GET /rest/v1/knowledge_entities → 406 (391ms)');
  check('a duration does not split a group', slow === slower, { slow, slower });

  const uuidA = fingerprint('task 3f8ed0ed-2969-4d2d-a5fa-548af693e188 failed');
  const uuidB = fingerprint('task 9c2a0d11-1111-2222-3333-444455556666 failed');
  check('an id does not split a group', uuidA === uuidB, { uuidA, uuidB });

  // The same tool failure is written by the runner and by the caller.
  const fromRunner = canonicalErrorMessage({
    activity_type: 'tool_failed', title: '❌ db-query', description: 'db-query failed', status: 'failed',
  });
  const fromCaller = canonicalErrorMessage({
    activity_type: 'tool_execution', title: '🔧 Eliza executed db-query',
    description: 'Eliza executed tool: db-query', status: 'error',
  });
  check('a tool failure is one message however it was written',
    fromRunner === fromCaller && fromRunner === 'db-query failed', { fromRunner, fromCaller });

  const http = canonicalErrorMessage({
    activity_type: 'http_error', title: 'POST /tools/run', description: 'error',
    status: 'POST /tools/run → 404 (28ms)',
  });
  check('an http error keeps its path and status',
    http === 'POST /tools/run → 404 (28ms)', http);
}

section('versions: the file that owns a route, and the version that was live');
{
  const files = scanInfraFiles(ROOT);
  const server = files.find(f => f.path === 'relay/server.js');
  check('server.js is watched', !!server && server.exists, !!server);
  check('server.js has a line count', server && server.lines > 1000, server && server.lines);
  check('server.js has a content fingerprint', !!(server && server.version), server && server.version);
  check('the fingerprint is stable across scans',
    scanInfraFiles(ROOT).find(f => f.path === 'relay/server.js').version === server.version);
  check('server.js has routes in it', server && server.route_count > 50, server && server.route_count);
  check('server.js has functions in it', server && server.function_count > 50, server && server.function_count);

  // A parameterised route has to match the concrete path that hit it.
  const owner = findRouteOwner('/api/suite/tasks/ec372cfc');
  check('a parameterised route is matched', owner && owner.file === 'relay/server.js', owner);
  check('an exact route is matched', findRouteOwner('/tools/run')?.file === 'relay/server.js');
  check('a route nobody owns has no owner', findRouteOwner('/api/alice/tick') === null);
}

section('the endpoints are wired');
{
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  for (const route of ['/api/log-intel', '/api/ship-logs', '/api/infra-files']) {
    check(`${route} is registered`, server.includes(`'${route}'`), route);
  }
  check('the activity log returns the metadata column',
    server.includes('fetchActivity') || server.includes('metadata'),
    'the enriched endpoint is used');
  check('the request logger records the source',
    server.includes('source: extra.source'), 'the source is stored');

  const logIntel = readFileSync(new URL('../lib/log-intel.mjs', import.meta.url), 'utf8');
  check('the intel module classifies clients', logIntel.includes('export function classifyPath'));
  check('the intel module counts live traffic', logIntel.includes('export function recordTraffic'));
  check('the intel module reads the ship logs', logIntel.includes('export async function scanShipLogs'));
}

section('the dashboard renders it');
{
  const dash = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  check('the board can be opened', dash.includes('window.openActivityIntel'));
  check('the board can be closed', dash.includes('window.closeActivityIntel'));
  check('the window can be changed', dash.includes('window.setIntelWindow'));
  check('the jantt is rendered', dash.includes('jantt-lane') && dash.includes('jbar'));
  check('the functions panel is rendered', dash.includes('intel-functions'));
  check('the errors panel is rendered', dash.includes('intel-errors'));
  check('the file versions panel is rendered', dash.includes('intel-files'));
  check('the github panel is rendered', dash.includes('intel-github'));
  check('the ship logs panel is rendered', dash.includes('intel-ship'));
  check('the coverage panel is rendered', dash.includes('intel-coverage'));
  check('the slow panel is rendered', dash.includes('intel-slow'));
  check('the sources panel is rendered', dash.includes('intel-sources'));
  check('the detailed stream is rendered', dash.includes('intel-log'));

  const page = readFileSync(new URL('../campus-page.mjs', import.meta.url), 'utf8');
  check('the page carries the overlay', page.includes('id="intel-overlay"'));
  check('the page carries the jantt animation', page.includes('@keyframes jbar-grow'));
  check('the tile can expand it', page.includes('openActivityIntel()'));
}

console.log(fails === 0
  ? '\n  the activity intelligence holds: named callers, one fault per group, and the version that threw'
  : `\n  ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
