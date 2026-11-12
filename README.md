# ScreenLogic Pool Bridge

Home Assistant app using node-screenlogic 2.1.1 remote connections and native
MQTT discovery. Requires the official Mosquitto app. It exposes pool
readings, an 83°F heater target, heat on/off, pool circulation on, and
optionally individual Pool Light and Spa Light switches.

Configure two pools with a private remote system name/password, unique four-digit
ID, verified pool circuit and pump ID. Control is disabled by default. Credentials
belong in protected app options, never this repository. No listening network ports.

No booking rules, startup writes, automatic command retry, retained commands,
pump-off command or spa equipment commands. The external controller owns
authorization and must verify the device-reported state after every command.
The app polls observations once per minute and marks failures unavailable. Network
sessions run in bounded child processes with library reconnect disabled.

Each home has one active session and at most one pending command. While busy,
the first pending command wins; later commands are dropped. The pending command
runs only if it is less than 30 seconds old when the active session finishes.
This transport queue is not an acknowledgement or a desired-state queue. The
cloud owner serializes its own steps and requires independent equipment readback
before proceeding; it retains uncertain intents instead of blindly retrying.

Turning Automation off persists the pause and clears pending work. An already
dispatched child retains its original control permission and may finish, as the
owning pool runbook specifies. Restart/reconnect begins with reads only. A paused
state publication is not proof that an earlier command was cancelled.

To enable lighting, configure the verified `pool_light_circuit` and
`spa_light_circuit` IDs for each home. Fresh controller evidence must match
the configured circuit name and a lighting function before any write. The
individual switches publish controller-reported state. Home Assistant can use
the non-retained `screenlogic_pool/<id>/set/lights` topic to set both mapped
lights to `on` or `off` in one session. Lighting has its own pending slot and
does not use the heater pause switch. Both still require `allow_control`.

With `lighting_latitude`, `lighting_longitude` and an IANA
`lighting_time_zone`, the bridge publishes the next descending −4° solar
elevation and 22:00 local time as timestamp sensors. Home Assistant owns the
automation. The bridge never schedules commands or replays missed times.

`node --test *.test.mjs` in `screenlogic_pool/` covers decoding/command bounds and
executes the bridge body with fake MQTT, child processes, files and time. It checks
queue order/expiry, per-home independence, pause persistence and admission races,
and success/exit/timeout settlement without replay. No broker or device is used;
these checks do not establish physical command timing or delivery.
