#!/usr/bin/env node
/**
 * tests/pfp-bookings-tool.test.mjs — the tool that could not create a booking.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A booking was missing from public.pfp_bookings: Mitchell Lauria's KCIC
 * holiday party on 4 December. The lead held the whole booking - the date,
 * the timing, the $1,495 Stripe payment - and the task that was supposed to
 * create the row said so in its checklist. The row was never created.
 *
 * The reason was not that nobody did it. The tool was broken:
 *
 *   pfp_bookings: create
 *     INSERT INTO public.pfp_bookings (..., package_id, event_location,
 *                                      duration_hours, total_price, ...)
 *
 * and public.pfp_bookings has none of those columns - they belong to
 * app.pfp_bookings, the other bookings table. Every create died with
 *
 *   column "package_id" of relation "pfp_bookings" does not exist
 *
 * and every list that was asked for a payment_status died the same way.
 * The only way in was broken, so the booking could not be created by the
 * thing whose job is creating bookings.
 *
 * These tests check the columns against the table that is actually there.
 * A test that only checks "the handler returns something" would have passed
 * while the tool was broken, which is the mistake that let this sit.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log('  PASS  ' + label); return; }
  fails++;
  console.log('  FAIL  ' + label + (detail !== undefined ? `  -> ${detail}` : ''));
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const src = readFileSync(join(RELAY_DIR, 'xmrtdao-suite-mcp.mjs'), 'utf8');

// The tool block, read out of the file. It is not imported because
// importing the module starts the MCP server's stdin listener.
//
// The block runs from "pfp_bookings: {" to the next tool, so the slice is
// the tool and nothing else - a slice that stopped early would pass the
// checks by not containing the thing being checked.
const pfpTool = src.indexOf('  pfp_bookings: {');
const nextTool = src.indexOf('\n  hb_properties: {', pfpTool);
const block = pfpTool === -1 ? '' : src.slice(pfpTool, nextTool === -1 ? undefined : nextTool);
const handler = block;

section('the handler exists and is the bookings one');
{
  check('the pfp_bookings tool is there', pfpTool !== -1);
  check('the block runs to the next tool', nextTool > pfpTool, `next=${nextTool}`);
  check('it has a handler', /handler: async \(args\) => \{/.test(block));
  check('it has an input schema', /inputSchema: \{/.test(block));
}

section('it names only columns public.pfp_bookings actually has');
{
  // The columns the table has, from the migration that created it and the
  // probes run against the live database.
  const REAL = [
    'id', 'lead_id', 'client_name', 'client_email', 'client_phone', 'event_name',
    'event_type', 'event_date', 'event_start_time', 'event_end_time', 'venue',
    'address', 'package_type', 'hours', 'total_fee', 'deposit_paid', 'deposit_date',
    'status', 'contract_sent', 'contract_signed', 'attendants', 'addons', 'notes',
    'created_at', 'updated_at', 'event_name_is_placeholder',
  ];

  // Every identifier the INSERT lists between its parentheses.
  const insert = (handler.match(/INSERT INTO public\.pfp_bookings\s*\(([\s\S]*?)\)\s*VALUES/) || [])[1] || '';
  const named = insert.split(',').map((c) => c.trim()).filter(Boolean);
  check('the insert names columns', named.length > 0, insert);

  const bad = named.filter((c) => !REAL.includes(c));
  check('every column it inserts exists', bad.length === 0, `not in the table: ${bad.join(', ')}`);

  // The columns it used to name, which belong to the OTHER table.
  const OTHER_TABLE = ['package_id', 'event_location', 'duration_hours', 'total_price', 'payment_status'];
  for (const c of OTHER_TABLE) {
    check(`it does not insert the other table's "${c}"`, !named.includes(c));
  }
}

section('the LIST query does not filter on a column that is not there');
{
  const listSql = (handler.match(/let sql = 'SELECT \* FROM public\.pfp_bookings[^;]*;/s) || [])[0] || '';
  check('there is a list query', listSql.length > 0);
  check('it does not filter on payment_status as a column',
    !/AND payment_status = \$/.test(listSql), listSql.slice(0, 200));
  check('it orders by the event date, so the next shoot is first',
    /ORDER BY event_date DESC/.test(handler), 'no ORDER BY event_date');
}

section('the argument names in the schema are this table\'s');
{
  const schema = block;
  for (const good of ['hours', 'total_fee', 'venue', 'event_start_time', 'event_end_time', 'deposit_paid']) {
    check(`the schema names "${good}"`, schema.includes(good));
  }
  // The old names are still accepted, because the other table uses them.
  check('it still accepts duration_hours', schema.includes('duration_hours'));
  check('it still accepts total_price', schema.includes('total_price'));
  check('it still accepts event_location', schema.includes('event_location'));
  check('payment_status is described as a filter, not a column',
    /payment_status[\s\S]{0,220}deposit_paid/.test(schema));
}

section('a failed insert is reported, not swallowed');
{
  check('the create is wrapped in a try', /try \{[\s\S]{0,80}INSERT INTO public\.pfp_bookings/.test(handler));
  check('a failure returns an error', /success: false, error: `the booking was not created/.test(handler));
  check('and it says what went wrong', /\$\{e\.message\}/.test(handler));
}

section('the tool refuses to create a half-built booking');
{
  check('it still requires the client name', /!client_name/.test(handler));
  check('it still requires the client email', /!client_email/.test(handler));
  check('it still requires the event date', /!event_date/.test(handler));
  check('it still requires the hours', /!hours/.test(handler));
  check('it still requires the total', /!total_fee/.test(handler));
}

console.log('');
if (fails) {
  console.log(`${fails} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
process.exit(0);
