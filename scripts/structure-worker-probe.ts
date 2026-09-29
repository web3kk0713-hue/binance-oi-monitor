/** Execute the emitted calculation bundle in an isolated Node worker bridge. Not a browser acceptance test. */
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';
import { createStructureComputationClient, type StructureComputationWorker } from '../src/web/structureComputation';
import { startStructureShadow, validStructureShadowBook } from '../src/shared/structureReplay';
import { structureFixture } from '../tests/structure-fixture';

const files = (await readdir(resolve('dist/assets'))).filter(file => /^structure\.worker-.*\.js$/.test(file));
if (files.length !== 1) throw new Error('Build first; expected exactly one emitted structure worker');
const bundleUrl = pathToFileURL(resolve('dist/assets', files[0])).href;
const client = createStructureComputationClient(() => {
  const worker = new NodeWorker(`const {parentPort,workerData}=require('node:worker_threads');
    global.self={addEventListener:(type,listener)=>{if(type==='message')parentPort.on('message',data=>listener({data}));},postMessage:message=>parentPort.postMessage(message)};
    import(workerData.url).catch(error=>{throw error;});`, { eval: true, workerData: { url: bundleUrl } });
  const bindings = new Map<(event: Event) => void, { type: string; handler: (value: unknown) => void }>();
  const bridge: StructureComputationWorker = {
    postMessage: value => worker.postMessage(value), terminate: () => { void worker.terminate(); },
    addEventListener(type, listener) {
      const handler = (value: unknown) => listener(type === 'message'
        ? new MessageEvent('message', { data: value })
        : Object.assign(new Event(type), { error: value }));
      bindings.set(listener, { type, handler }); worker.on(type, handler);
    },
    removeEventListener(_type, listener) { const binding = bindings.get(listener); if (binding) worker.off(binding.type, binding.handler); bindings.delete(listener); },
  };
  return bridge;
});
try {
  const input = structureFixture(), output = await client.analyze(input);
  if (output.result.status !== 'ready' || output.replay !== null) throw new Error('Live bundle computation failed');
  const record = startStructureShadow('bundle-check', output.result.advice, input.reference, input.now);
  if (!validStructureShadowBook({ schemaVersion: 1, revision: 1, updatedAt: input.now, records: [record] })) throw new Error('Emitted bundle does not round-trip through shadow contract');
  const replay = await client.analyze({ ...input, mode: 'replay' }, 4 * 3_600_000);
  if (replay.result.status !== 'ready' || replay.replay?.outcome !== 'incomplete') throw new Error('Replay must disclose missing future bars');
  console.log(JSON.stringify({ scope: 'Synthetic fixture; actual production calculation bundle in Node worker bridge, not browser or live position',
    bundle: files[0], live: 'ready', stop: record.advice.stop.price, target1: record.advice.target1.price,
    persistenceContract: 'passed', replay: replay.replay.outcome }));
} finally { client.close(); }
