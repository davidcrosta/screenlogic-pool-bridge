import test from 'node:test';
import assert from 'node:assert/strict';
import {poolSnapshot,permitted} from './session.mjs';
const config={degC:false,circuitArray:[{circuitId:6,function:2},{circuitId:1,function:1}]};
const state={bodies:[{id:1,currentTemp:72,setPoint:83,heatMode:0,heatStatus:0},{id:2,currentTemp:100,setPoint:104,heatMode:3,heatStatus:1}],
  circuitArray:[{id:6,state:1},{id:1,state:0}],panelMode:1,freezeMode:0};
const pump={isRunning:true,pumpWatts:800,pumpRPMs:2500,pumpGPMs:0};
test('pool decoding excludes spa and refuses incorrect circuit or units',()=>{
  const s=poolSnapshot(config,state,pump,{pool_circuit:6});assert.equal(s.temperature,72);assert.equal(s.heating,false);
  assert.throws(()=>poolSnapshot(config,state,pump,{pool_circuit:1}));
  assert.throws(()=>poolSnapshot({...config,degC:true},state,pump,{pool_circuit:6}));
  assert.equal(poolSnapshot(config,state,{...pump,pumpWatts:0}, {pool_circuit:6}).pumpRunning,null);
});
test('only 83F and 88F, heat off/gas and pool circulation on can be commanded',()=>{
  const s=poolSnapshot(config,state,pump,{pool_circuit:6});
  assert.equal(permitted('mode','gas',s),true);assert.equal(permitted('temperature','83',s),true);
  assert.equal(permitted('temperature','88.0',s),true);
  assert.equal(permitted('mode','gas',{...s,target:88}),true);
  for(const value of ['84','87','89','88.1',' 88','8.8e1'])assert.equal(permitted('temperature',value,s),false);
  assert.equal(permitted('mode','gas',{...s,target:87}),false);
  assert.equal(permitted('pump','off',s),false);
  assert.equal(permitted('mode','gas',{...s,poolOn:false}),false);
  assert.equal(permitted('mode','gas',{...s,spaOn:true}),false);
  assert.equal(permitted('pump','on',{...s,spaOn:true}),false);
  assert.equal(permitted('temperature','88',{...s,spaOn:true}),false);
  assert.equal(permitted('mode','off',{...s,spaOn:true}),true);
});
test('motor telemetry can fail without losing the equipment read, and unavailable is distinct from Villa unsupported',()=>{
  const absent=poolSnapshot(config,state,null,{id:'2033',pool_circuit:6},1234);
  assert.equal(absent.observedAt,1234);assert.equal(absent.poolOn,true);
  assert.equal(absent.pumpRunning,null);assert.equal(absent.motorFeedback,'unavailable');
  assert.equal(permitted('mode','gas',absent),false);
  const report={isRunning:true,pumpWatts:0,pumpRPMs:0,pumpGPMs:4294967295};
  const villa=poolSnapshot(config,state,report,{id:'2070',pool_circuit:6});
  assert.equal(villa.motorFeedback,'unsupported');assert.equal(villa.pumpGpm,null);
  assert.equal(permitted('mode','gas',villa),true);
  assert.equal(poolSnapshot(config,state,report,{id:'2033',pool_circuit:6}).motorFeedback,'unavailable');
  const spa=poolSnapshot(config,{...state,circuitArray:[{id:6,state:1},{id:1,state:1}]},pump,{pool_circuit:6});
  assert.deepEqual(spa.spa,{temperature:100,target:104,heating:true});
  const unknown=poolSnapshot(config,{...state,circuitArray:[{id:6,state:1}]},pump,{pool_circuit:6});
  assert.equal(unknown.spaKnown,false);assert.equal(permitted('pump','on',unknown),false);
  assert.equal(permitted('mode','off',unknown),true);
});
