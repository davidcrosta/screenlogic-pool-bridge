import test from 'node:test';
import assert from 'node:assert/strict';
import {poolSnapshot,permitted} from './session.mjs';
const config={degC:false,circuitArray:[{circuitId:6,function:2},{circuitId:1,function:1}]};
const state={bodies:[{id:1,currentTemp:72,setPoint:83,heatMode:0,heatStatus:0},{id:2,currentTemp:100,setPoint:104,heatMode:3,heatStatus:1}],
  circuitArray:[{id:6,state:1},{id:1,state:0}],panelMode:1,freezeMode:0};
const pump={isRunning:true,pumpWatts:800};
test('pool decoding excludes spa and refuses incorrect circuit or units',()=>{
  const s=poolSnapshot(config,state,pump,{pool_circuit:6});assert.equal(s.temperature,72);assert.equal(s.heating,false);
  assert.throws(()=>poolSnapshot(config,state,pump,{pool_circuit:1}));
  assert.throws(()=>poolSnapshot({...config,degC:true},state,pump,{pool_circuit:6}));
});
test('only 83F, heat off/gas and pool circulation on can be commanded',()=>{
  const s=poolSnapshot(config,state,pump,{pool_circuit:6});
  assert.equal(permitted('mode','gas',s),true);assert.equal(permitted('temperature','83',s),true);
  assert.equal(permitted('temperature','84',s),false);assert.equal(permitted('pump','off',s),false);
  assert.equal(permitted('mode','gas',{...s,pumpRunning:false}),false);
  assert.equal(permitted('mode','gas',{...s,spaOn:true}),false);
  assert.equal(permitted('pump','on',{...s,spaOn:true}),false);
  assert.equal(permitted('mode','off',{...s,spaOn:true}),true);
});
