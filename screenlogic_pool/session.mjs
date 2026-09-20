// Isolated bounded session: no library reconnect, command retry or startup writes.
import ScreenLogic from 'node-screenlogic';
export function poolSnapshot(config,state,pump,options,at=Date.now()) {
  const pool=state.bodies?.filter(b=>b.id===1),circuit=config.circuitArray?.filter(c=>c.circuitId===options.pool_circuit&&c.function===2);
  const enabled=state.circuitArray?.find(c=>c.id===options.pool_circuit);
  const spa=config.circuitArray?.filter(c=>c.function===1).some(c=>state.circuitArray?.find(s=>s.id===c.circuitId)?.state!==0);
  if(config.degC!==false||pool?.length!==1||circuit?.length!==1||![0,1].includes(enabled?.state)||
    !Number.isFinite(pool[0].currentTemp)||pool[0].currentTemp<32||pool[0].currentTemp>110||
    !Number.isFinite(pool[0].setPoint)||![0,1,2,3].includes(pool[0].heatMode)||
    typeof pump.isRunning!=='boolean')throw Error('invalid_pool_evidence');
  return {observedAt:at,temperature:pool[0].currentTemp,target:pool[0].setPoint,heatMode:pool[0].heatMode,
    heating:pool[0].heatStatus!==0,poolOn:enabled.state===1,
    pumpRunning:!pump.isRunning?false:pump.pumpWatts>0&&pump.pumpWatts<5000&&
      (pump.pumpRPMs>0&&pump.pumpRPMs<5000||pump.pumpGPMs>0&&pump.pumpGPMs<300)?true:null,pumpWatts:pump.pumpWatts,
    spaOn:Boolean(spa),panelMode:state.panelMode,freezeMode:state.freezeMode,unit:'F'};
}
export function permitted(action,value,s) {
  if(action==='mode'&&value==='off')return true;
  return s.panelMode===1&&!s.spaOn&&(
    action==='temperature'&&Number(value)===83||action==='pump'&&value==='on'||
    action==='mode'&&value==='gas'&&s.poolOn&&s.target===83);
}
if(process.send)process.once('message',async({options,action='read',value})=>{
  const fail=code=>{process.send?.({ok:false,code});process.exit(1);};
  setTimeout(()=>fail('connection_timeout'),25000);
  try {
    const gateway=await new ScreenLogic.RemoteLogin(options.system_name).connectAsync();
    if(!gateway.gatewayFound||!gateway.ipAddr||!Number.isInteger(gateway.port))return fail('gateway_unavailable');
    const c=new ScreenLogic.UnitConnection();c.netTimeout=7000;c.reconnectAsync=async()=>fail('connection_interrupted');
    c.init(options.system_name,gateway.ipAddr,gateway.port,options.password);await c.connectAsync();
    const read=async()=>poolSnapshot(await c.equipment.getControllerConfigAsync(),await c.equipment.getEquipmentStateAsync(),
      await c.pump.getPumpStatusAsync(options.pump_id),options);
    const before=await read();
    if(action!=='read') {
      if(!options.allow_control||!permitted(action,value,before))return fail('command_rejected');
      if(action==='temperature')await c.bodies.setSetPointAsync(0,83);
      else if(action==='mode')await c.bodies.setHeatModeAsync(0,value==='off'?0:3);
      else if(action==='pump')await c.circuits.setCircuitStateAsync(options.pool_circuit,true);
    }
    process.send?.({ok:true,snapshot:action==='read'?before:await read()});process.exit(0);
  }catch{fail(action==='read'?'read_failed':'command_uncertain');}
});
