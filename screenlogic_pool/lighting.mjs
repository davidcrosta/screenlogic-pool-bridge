import SunCalc from 'suncalc';

export const lightCircuits = {
  pool_light: { option: 'pool_light_circuit', name: 'Pool Light' },
  spa_light: { option: 'spa_light_circuit', name: 'Spa Light' },
};

export function lightStates(config, state, options) {
  return Object.fromEntries(Object.entries(lightCircuits).flatMap(([key, { option, name }]) => {
    const id = options[option];
    const circuits = config.circuitArray?.filter(circuit => circuit.circuitId === id);
    const readings = state.circuitArray?.filter(circuit => circuit.id === id);
    if (!Number.isInteger(id) || id === options.pool_circuit ||
        circuits?.length !== 1 || circuits[0].name !== name ||
        ![7, 16].includes(circuits[0].function) ||
        readings?.length !== 1 || ![0, 1].includes(readings[0].state)) return [];
    return [[key, readings[0].state === 1 ? 'on' : 'off']];
  }));
}

// Resolve the wall-clock cutoff for the event's date, including DST transitions.
function cutoff(date, wallClock) {
  const fields = wallClock.formatToParts(date);
  const field = type => Number(fields.find(part => part.type === type).value);
  const [year, month, day, hour, minute] = ['year', 'month', 'day', 'hour', 'minute'].map(field);
  const offset = Date.UTC(year, month - 1, day, hour, minute) - date.getTime();
  return new Date(Date.UTC(year, month - 1, day, 22) - offset);
}

SunCalc.addTime(-4, 'lightingDawn', 'lightingDusk');

export function nextLightingTimes(now, latitude, longitude, timeZone) {
  const wallClock = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  });
  const localDate = Object.fromEntries(wallClock.formatToParts(now).map(({ type, value }) => [type, Number(value)]));
  const solarNoon = offset => {
    // A UTC minute near local noon anchors SunCalc to the intended local day.
    const date = Date.UTC(localDate.year, localDate.month - 1, localDate.day + offset, 12);
    const localHour = Number(wallClock.formatToParts(date).find(part => part.type === 'hour').value);
    const localDay = Number(wallClock.formatToParts(date).find(part => part.type === 'day').value);
    const desiredDay = new Date(date).getUTCDate();
    const dayDifference = localDay === desiredDay ? 0 : localHour < 12 ? 24 : -24;
    return new Date(date + (12 - localHour - dayDifference) * 3600000);
  };
  const events = [solarNoon(0), solarNoon(1)].map(date => ({
    dusk: SunCalc.getTimes(date, latitude, longitude).lightingDusk,
    cutoff: cutoff(date, wallClock),
  }));
  return Object.fromEntries(['dusk', 'cutoff'].map(key => [
    key, events.find(event => event[key] > now)?.[key].toISOString(),
  ]));
}
