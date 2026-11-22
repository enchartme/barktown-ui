import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { reanalysis, refreshReanalysis, reanalysisFetch } from '../src/lib/reanalysis.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('clients track remote progress, fail closed on disconnect, and reserve locally through status refresh', async t => {
  const events = [];
  globalThis.window = new EventTarget();
  t.after(() => { delete globalThis.window; });
  window.addEventListener('reanalysis-update', event => events.push(event.detail));
  let serverState = { revision: 0, active: false, currentIds: [] };
  let connected = true;
  let statusGate;
  const postGate = deferred();
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/api/reanalysis')) {
      if (!connected) throw new Error('disconnected');
      if (statusGate) await statusGate.promise;
      return { ok: true, json: async () => ({ ...serverState }) };
    }
    return postGate.promise;
  });
  let observed;
  const unsubscribe = reanalysis.subscribe(value => { observed = value; });
  t.after(unsubscribe);
  await setImmediate();
  assert.equal(observed.available, true);
  serverState = { id: 'remote-day', revision: 1, kind: 'day', active: true, completed: 0, currentIds: ['a'] };
  await refreshReanalysis();
  assert.equal(observed.active, true);
  assert.deepEqual(observed.currentIds, ['a']);
  await assert.rejects(reanalysisFetch('/start', {}), /already in progress/);
  connected = false;
  await refreshReanalysis();
  assert.equal(observed.available, false);
  assert.equal(observed.active, true);
  connected = true;
  serverState = { ...serverState, revision: 2, active: false, completed: 1, currentIds: [] };
  await refreshReanalysis();
  assert.equal(observed.active, false);
  assert.equal(events.at(-1).completed, 1);
  const count = events.length;
  await refreshReanalysis();
  assert.equal(events.length, count, 'unchanged polls do not reload the report');

  const run = reanalysisFetch('/start', {});
  assert.equal(observed.active, true, 'disable all local buttons immediately');
  await assert.rejects(reanalysisFetch('/start-again', {}), /already in progress/);
  statusGate = deferred();
  postGate.resolve({ ok: true });
  await setImmediate();
  assert.equal(observed.active, true, 'keep reservation until authoritative status arrives');
  await assert.rejects(reanalysisFetch('/start-during-refresh', {}), /already in progress/);
  serverState = { ...serverState, id: 'new-job', revision: 3, active: true, currentIds: ['b'] };
  statusGate.resolve();
  await run;
  assert.equal(observed.active, true);
  assert.deepEqual(observed.currentIds, ['b']);
});
