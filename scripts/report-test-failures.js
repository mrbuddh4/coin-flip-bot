// Surface bounded test failures in hosted check annotations as well as logs.
const fs = require('node:fs');
try {
  const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const encode = text => String(text).replace(/\x1b\[[0-9;]*m/g, '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  for (const test of report.testResults || []) {
    if (test.status !== 'failed') continue;
    const message = (test.message || (test.assertionResults || []).flatMap(a => a.failureMessages || []).join('\n')).slice(0, 6000);
    process.stdout.write('::error::' + encode(message || 'Test suite failed without a message') + '\n');
  }
} catch (_) { process.stdout.write('::error::Test results unavailable; inspect the test step log.\n'); }
