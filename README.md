# ScreenLogic Pool Bridge

Home Assistant app using node-screenlogic 2.1.1 remote connections and native
MQTT discovery. Requires the official Mosquitto app. It exposes only pool
readings, an 83°F heater target, heat on/off and pool circulation on.

Configure two pools with a private remote system name/password, unique four-digit
ID, verified pool circuit and pump ID. Control is disabled by default. Credentials
belong in protected app options, never this repository. No listening network ports.

No booking rules, scheduler for business actions, startup writes, automatic command
retry, retained commands, pump-off command or spa commands. The external controller
owns authorization and must verify the device-reported state after every command.
The app polls observations once per minute and marks failures unavailable. Network
sessions run in bounded child processes with library reconnect disabled.
