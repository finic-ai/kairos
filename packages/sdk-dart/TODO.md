# TODO

Signals that need native code (Kotlin and Swift). They make `finic_kairos` a Flutter plugin
package with `android/` and `ios/` folders. None of them needs a runtime permission.

## Live signals

Read at each event and each `decide`, not once at launch.

- [ ] `on_call`: a phone or VoIP call is active. iOS: `CXCallObserver` (CallKit).
  Android: `AudioManager.getMode()` is `MODE_IN_CALL` or `MODE_IN_COMMUNICATION`. Do not use
  `TelephonyManager`, which needs `READ_PHONE_STATE`.
- [ ] `screen_captured`: the screen is recorded or mirrored. iOS: `UIScreen.isCaptured`.
  Android 14+: `Activity.registerScreenCaptureCallback` (screenshots only).
- [ ] An API to send live signals with each event, separate from the launch facts.

## Device facts

- [ ] `rooted` (Android): `su` binaries, Magisk paths, writable system paths.
- [ ] `jailbroken` (iOS): Cydia and Sileo paths, writable paths outside the sandbox.
- [ ] `adb_enabled`, `developer_options` (Android): `Settings.Global`.
- [ ] `accessibility_services` (Android): the enabled services, from
  `Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES`. Remote-control malware uses them.

## Docs

- [ ] Add each new signal to `docs/reference/clients/dart.md`.
