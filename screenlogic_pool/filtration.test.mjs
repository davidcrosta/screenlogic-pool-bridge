import test from 'node:test';
import assert from 'node:assert/strict';
import {filtrationForecast} from './filtration.mjs';

const observedAt=Date.parse('2026-11-25T13:00:00Z');
const clock={year:2026,month:11,day:25,hour:5,minute:2,second:0};
const run={circuitId:6,startTime:'0600',stopTime:'1400',dayMask:4,flags:0,heatCmd:4};

test('next verified recurring Pool forecast uses Pacific wall time and controller drift',()=>{
  assert.deepEqual(filtrationForecast(clock,[run],[],6,observedAt),{observedAt,clockOffsetMinutes:2,
    startAt:Date.parse('2026-11-25T13:58:00Z'),endAt:Date.parse('2026-11-25T21:58:00Z')});
  assert.equal(filtrationForecast(clock,[{...run,circuitId:4}],[],6,observedAt).startAt,null);
  assert.equal(filtrationForecast(clock,[run],[{circuitId:6}],6,observedAt).startAt,null);
  for(const change of [{flags:2},{heatCmd:0},{startTime:'2200'},{stopTime:'unavailable'}])
    assert.equal(filtrationForecast(clock,[{...run,...change}],[],6,observedAt).startAt,null);
  assert.equal(filtrationForecast({...clock,minute:30},[run],[],6,observedAt).startAt,null);
});
