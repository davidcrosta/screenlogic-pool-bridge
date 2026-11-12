import test from 'node:test';
import assert from 'node:assert/strict';
import { lightStates, nextLightingTimes } from './lighting.mjs';
import { switchLights } from './session.mjs';

const location = [33.83, -116.54, 'America/Los_Angeles'];

test('Pacific cutoff uses the date of the evening, including both DST weekends', () => {
  const cases = [
    ['2026-03-07T22:00:00Z', '2026-03-08T06:00:00.000Z'],
    ['2026-03-08T06:01:00Z', '2026-03-09T05:00:00.000Z'],
    ['2026-10-31T22:00:00Z', '2026-11-01T05:00:00.000Z'],
    ['2026-11-01T05:01:00Z', '2026-11-02T06:00:00.000Z'],
  ];
  for (const [now, expected] of cases) {
    assert.equal(nextLightingTimes(new Date(now), ...location).cutoff, expected);
  }
});

test('Palm Springs dusk varies by season and rolls over independently from cutoff', () => {
  const summer = nextLightingTimes(new Date('2026-06-21T20:00:00Z'), ...location);
  const winter = nextLightingTimes(new Date('2026-12-21T20:00:00Z'), ...location);
  assert.match(summer.dusk, /^2026-06-22T03:/);
  assert.match(winter.dusk, /^2026-12-22T00:/);
  const afterDusk = nextLightingTimes(new Date(Date.parse(winter.dusk) + 60000), ...location);
  assert.match(afterDusk.dusk, /^2026-12-23T/);
  assert.equal(afterDusk.cutoff, winter.cutoff);
});

const config = { circuitArray: [
  { circuitId: 4, name: 'Pool Light', function: 7 },
  { circuitId: 5, name: 'Spa Light', function: 16 },
  { circuitId: 6, name: 'Pool', function: 2 },
  { circuitId: 7, name: 'Beach Light', function: 16 },
] };
const options = { pool_light_circuit: 4, spa_light_circuit: 5, pool_circuit: 6, allow_lighting: true };
const state = (pool, spa) => ({
  panelMode: 1,
  circuitArray: [{ id: 4, state: pool }, { id: 5, state: spa }, { id: 6, state: 1 }, { id: 7, state: 0 }],
});

test('the four named targets must map to an actual light, never a pump or another auxiliary', () => {
  assert.deepEqual(lightStates(config, state(1, 0), options), { pool_light: 'on', spa_light: 'off' });
  for (const circuit of [5, 6, 7]) {
    assert.deepEqual(lightStates(config, state(1, 0), { ...options, pool_light_circuit: circuit }), { spa_light: 'off' });
  }
});

test('each light receives one explicit command and an unconfirmed command cannot hide the other result', async () => {
  const calls = [];
  const client = {
    circuits: { async setCircuitStateAsync(id, on) {
      calls.push([id, on]);
      if (id === 4) throw Error('timeout');
    } },
    equipment: { getEquipmentStateAsync: async () => state(1, 0) },
  };
  const result = await switchLights(client, config, state(1, 1), options, 'lights', 'off');
  assert.deepEqual(calls, [[4, false], [5, false]]);
  assert.deepEqual(result, { lights: { pool_light: 'on', spa_light: 'off' }, incomplete: true });
  calls.length = 0;
  await switchLights(client, config, state(1, 1), options, 'spa_light', 'off');
  assert.deepEqual(calls, [[5, false]]);
});
