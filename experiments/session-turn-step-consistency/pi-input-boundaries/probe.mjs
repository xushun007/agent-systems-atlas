import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Source code is imported unchanged. A narrow export facade avoids loading
// unrelated provider integrations from the pi-ai package entry point.
const [sourceArg, typeboxArg, outputArg] = process.argv.slice(2);
assert(sourceArg && typeboxArg, 'Usage: node probe.mjs <pi-source> <typebox-package> [results.json]');
const source = resolve(sourceArg);
const typebox = resolve(typeboxArg);
const commit = 'd981de1229ef899957bbe968bc8dcda02a21f477';
assert.equal(execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), commit);
const sourceFiles = [
  'packages/agent/src/agent.ts', 'packages/agent/src/agent-loop.ts',
  'packages/agent/src/stream-fn.ts', 'packages/ai/src/utils/event-stream.ts',
  'packages/ai/src/utils/validation.ts',
];
execFileSync('git', ['-C', source, 'diff', '--exit-code', 'HEAD', '--', ...sourceFiles]);
const typeboxMetadata = JSON.parse(readFileSync(resolve(typebox, 'package.json'), 'utf8'));
assert.equal(typeboxMetadata.version, '1.3.7');
const url = (relative) => pathToFileURL(resolve(source, relative)).href;
const facade = 'data:text/javascript,' + encodeURIComponent(
  `export { EventStream } from ${JSON.stringify(url(sourceFiles[3]))};\n` +
  `export { validateToolArguments } from ${JSON.stringify(url(sourceFiles[4]))};\n`,
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@earendil-works/pi-ai') return { url: facade, shortCircuit: true };
    if (specifier === 'typebox' || specifier.startsWith('typebox/')) {
      const key = specifier === 'typebox' ? '.' : './' + specifier.slice(8);
      const target = typeboxMetadata.exports[key]?.import;
      assert(target, `Unknown TypeBox export: ${specifier}`);
      return { url: pathToFileURL(resolve(typebox, target)).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { Agent } = await import(url(sourceFiles[0]));
const { AssistantMessageEventStream } = await import(url(sourceFiles[3]));
const { Type } = await import('typebox');

const model = (id) => ({
  id, name: id, api: 'test', provider: 'test', baseUrl: 'https://example.invalid',
  reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 2048,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const user = (content) => ({ role: 'user', content, timestamp: 0 });
const userTexts = (messages) => messages.filter((m) => m.role === 'user').map((m) =>
  typeof m.content === 'string' ? m.content : m.content.filter((p) => p.type === 'text').map((p) => p.text).join(''),
);
const usage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const deferred = () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
};
const toolsResponse = [1, 2].map((number) => ({
  type: 'toolCall', id: `tool-${number}`, name: 'controlled', arguments: { number },
}));

async function scenario(name, kind, queueMode = 'all') {
  const toolStarted = deferred();
  const releaseTool = deferred();
  const prepStarted = deferred();
  const releasePrep = deferred();
  const events = [];
  const requests = [];
  const executed = [];
  const log = (event, fields = {}) => events.push({ order: events.length + 1, event, ...fields });
  let prepCount = 0;
  let agent;
  const tool = {
    name: 'controlled', label: 'Controlled', description: 'In-memory ordering probe',
    parameters: Type.Object({ number: Type.Number() }),
    async execute(_id, { number }) {
      log('tool-start', { number });
      if (number === 1) { toolStarted.release(); await releaseTool.promise; }
      executed.push(number);
      log('tool-complete', { number });
      return { content: [{ type: 'text', text: `result-${number}` }], details: { number } };
    },
  };
  agent = new Agent({
    initialState: { model: model('model-a'), systemPrompt: 'Controlled runtime experiment', tools: [tool] },
    steeringMode: queueMode, followUpMode: 'all', toolExecution: 'sequential',
    ...(kind === 'prepare-arrival' || kind === 'model-with-hook' ? {
      prepareNextTurn: async () => {
        if (kind === 'prepare-arrival' && ++prepCount === 1) {
          log('prepare-wait'); prepStarted.release(); await releasePrep.promise;
        }
        return kind === 'model-with-hook' ? { model: agent.state.model } : undefined;
      },
    } : {}),
    streamFn: (selectedModel, context) => {
      const number = requests.length + 1;
      assert(number <= 5, 'Unexpected continuation');
      // Snapshot immediately, before later context mutations can affect observations.
      const messages = structuredClone(context.messages);
      requests.push({ number, model: selectedModel.id, messages });
      log('model-request', {
        number, model: selectedModel.id,
        userInputs: userTexts(messages),
      });
      const content = number === 1 ? structuredClone(toolsResponse) : [{ type: 'text', text: `answer-${number}` }];
      const stopReason = number === 1 ? 'toolUse' : 'stop';
      const message = {
        role: 'assistant', content, api: 'test', provider: 'test', model: selectedModel.id,
        usage: usage(), stopReason, timestamp: 0,
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: 'done', reason: stopReason, message });
      return stream;
    },
  });
  agent.subscribe((event) => {
    if (event.type === 'turn_end' || event.type === 'agent_end') log(event.type);
  });
  const running = agent.prompt('initial-task');
  // An early failure must fail the probe rather than leave a barrier waiting forever.
  const waitFor = (barrier) => Promise.race([
    barrier.promise,
    running.then(() => { throw new Error(`Run completed before barrier in ${name}`); }),
  ]);
  await waitFor(toolStarted);
  if (kind === 'steer' || kind === 'two-steers') {
    agent.steer(user('preserve-interface'));
    if (kind === 'two-steers') agent.steer(user('add-regression-test'));
    log('input-enqueued', { kind, queueMode });
  } else if (kind === 'follow-up') {
    agent.followUp(user('preserve-interface'));
    log('input-enqueued', { kind });
  } else if (kind.startsWith('model-')) {
    agent.state.model = model('model-b');
    log('model-setting-updated', { stateModel: agent.state.model.id });
  }
  releaseTool.release();
  if (kind === 'prepare-arrival') {
    await waitFor(prepStarted);
    agent.steer(user('preserve-interface'));
    log('input-enqueued', { kind });
    releasePrep.release();
  }
  await running;
  assert.deepEqual(executed, [1, 2]);
  const inputs = requests.map((r) => userTexts(r.messages));
  assert.deepEqual(inputs[0], ['initial-task']);
  if (kind === 'steer' || kind === 'prepare-arrival') {
    assert.equal(requests.length, 2);
    assert.deepEqual(inputs[1], ['initial-task', 'preserve-interface']);
  } else if (kind === 'follow-up') {
    assert.equal(requests.length, 3);
    assert.deepEqual(inputs[1], ['initial-task']);
    assert.deepEqual(inputs[2], ['initial-task', 'preserve-interface']);
  } else if (kind === 'two-steers') {
    assert.equal(requests.length, queueMode === 'all' ? 2 : 3);
    assert.deepEqual(inputs[1], queueMode === 'all'
      ? ['initial-task', 'preserve-interface', 'add-regression-test']
      : ['initial-task', 'preserve-interface']);
    assert.deepEqual(inputs.at(-1), ['initial-task', 'preserve-interface', 'add-regression-test']);
  } else {
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((r) => r.model), kind === 'model-with-hook'
      ? ['model-a', 'model-b'] : ['model-a', 'model-a']);
    assert.equal(agent.state.model.id, 'model-b');
  }
  const secondRequest = events.find((e) => e.event === 'model-request' && e.number === 2).order;
  const secondTool = events.find((e) => e.event === 'tool-complete' && e.number === 2).order;
  assert(secondTool < secondRequest);
  assert.equal(agent.hasQueuedMessages(), false);
  assert.equal(events.at(-1).event, 'agent_end');
  return { name, passed: true, requests, executed, events };
}

const timeout = setTimeout(() => { console.error('Probe exceeded 15 seconds'); process.exit(1); }, 15000);
const results = [];
try {
  for (const [name, kind, mode] of [
    ['steer-during-tool-batch', 'steer', 'all'],
    ['follow-up-during-tool-batch', 'follow-up', 'all'],
    ['two-steers-all', 'two-steers', 'all'],
    ['two-steers-one-at-a-time', 'two-steers', 'one-at-a-time'],
    ['steer-during-preparation', 'prepare-arrival', 'all'],
    ['model-update-without-prepare-hook', 'model-without-hook', 'all'],
    ['model-update-with-prepare-hook', 'model-with-hook', 'all'],
  ]) results.push(await scenario(name, kind, mode));
} finally { clearTimeout(timeout); }
const report = {
  commit, node: process.version, typebox: typeboxMetadata.version,
  scope: 'Original Pi Agent and loop; scripted model stream; in-memory tools; no CLI, provider transport, or durable harness',
  importAdaptation: 'pi-ai facade re-exports original EventStream and validateToolArguments; original implementations unchanged',
  success: true, results,
};
if (outputArg) writeFileSync(resolve(outputArg), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ success: true, results: results.map(({ name, requests }) => ({
  name, requests: requests.map(({ number, model, messages }) => ({
    number, model, userInputs: userTexts(messages),
  })),
})) }, null, 2));
