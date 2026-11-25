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

test('a schedule read during filtration retains the current run through its stop',()=>{
  const now=observedAt+2*3600000;
  const f=filtrationForecast({...clock,hour:7},[run],[],6,now);
  assert.equal(f.startAt,Date.parse('2026-11-25T13:58:00Z'));
  assert.equal(f.endAt,Date.parse('2026-11-25T21:58:00Z'));
});

test('overlapping or adjoining timers cannot establish a unique scheduled stop',()=>{
  for(const startTime of ['1000','1400']){
    const extra={...run,startTime,stopTime:'1600'};
    assert.equal(filtrationForecast(clock,[run,extra],[],6,observedAt).startAt,null);
  }
});
