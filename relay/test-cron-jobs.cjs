const { fileURLToPath } = require('url');
const { dirname, join } = require('path');
const { writeFileSync, mkdirSync } = require('fs');

// Minimal test: just load jobs and print them
async function test() {
  const enginePath = join(__dirname, 'cron-engine-v2.mjs');
  const engineUrl = 'file:///' + enginePath.replace(/\\/g, '/');
  
  const engine = await import(engineUrl);
  const jobs = await engine.loadJobsFromPg();
  
  console.log('=== Jobs from PG ===');
  jobs.forEach(j => {
    console.log(`Job ${j.id}: ${j.name}, type=${j.type}, disabled=${j.disabled}, schedule=${j.schedule}`);
  });
  
  console.log('\n=== Enabled jobs ===');
  const enabled = jobs.filter(j => !j.disabled);
  enabled.forEach(j => {
    console.log(`Job ${j.id}: ${j.name}, type=${j.type}, command=${(j.command || '').slice(0, 60)}`);
  });
  
  console.log('\nTotal jobs:', jobs.length);
  console.log('Enabled jobs:', enabled.length);
}

test().catch(console.error);
