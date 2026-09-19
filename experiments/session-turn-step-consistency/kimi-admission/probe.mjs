// Run with tsx (tested: 4.21.0 on Node 26.5.0); no API calls.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? '../kimi-code');
const expected = 'e27ee60894d714e5844db75da69f29120a2bce43';
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(commit, expected, 'Use the recorded research revision');
const files = [
  'packages/agent-core-v2/src/agent/loop/stepRequest.ts',
  'packages/agent-core-v2/src/agent/loop/stepRequestQueue.ts',
  'packages/agent-core-v2/src/agent/contextMemory/types.ts',
];
execFileSync('git', ['-C', root, 'diff', '--exit-code', 'HEAD', '--', ...files]);
const { MessageStepRequest } = await import(pathToFileURL(resolve(root, files[0])));
const { StepRequestQueue } = await import(pathToFileURL(resolve(root, files[1])));
const message = (text, options) => new MessageStepRequest({
  role: 'user', content: [{ type: 'text', text }], toolCalls: [],
}, options);
const events = [];

const queue = new StepRequestQueue();
const first = message('inspect the code');
queue.enqueue(first);
assert.equal(first.state, 'pending');
events.push({ event: 'enqueue', requestState: first.state, pending: queue.hasPendingRequests() });
const batch = queue.takeNextBatch();
assert.equal(batch.driver, first);
assert.equal(first.state, 'pending');
events.push({ event: 'take-batch', requestState: first.state, pending: queue.hasPendingRequests() });
first.markMaterialized();
assert.equal(first.abort(), false);
events.push({ event: 'explicit-materialization', requestState: first.state, abortAccepted: false });

const cancelled = message('withdraw this input');
queue.enqueue(cancelled);
assert.equal(cancelled.abort(), true);
assert.equal(queue.hasPendingRequests(), false);
assert.equal(queue.takeNextBatch(), undefined);
events.push({ event: 'abort-pending', requestState: cancelled.state, returnedByQueue: false });

const driver = message('continue');
const supplement = message('preserve the public interface', { mergeable: true });
queue.enqueue(driver);
queue.enqueue(supplement);
const merged = queue.takeNextBatch();
assert.equal(merged.driver, driver);
assert.deepEqual(merged.merged, [supplement]);
assert.equal(driver.state, 'pending');
assert.equal(supplement.state, 'pending');
events.push({ event: 'merge', driverCount: 1, mergedCount: merged.merged.length, states: [driver.state, supplement.state] });

console.log(JSON.stringify({
  commit, node: process.version,
  scope: 'Original StepRequest and StepRequestQueue only; no AgentLoopService, model, UI, or persistence',
  events, success: true,
}, null, 2));
