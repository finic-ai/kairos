# Flutter

The client for Flutter apps, `finic_kairos`. It gives each install a device id, sends the screens that your [client settings](../api.md#client-settings) name as events, and sends the events that you track. It uses a public key, which can only send events.

- [Install](#install)
- [Start the client](#start-the-client)
- [Send the device to your server](#send-the-device-to-your-server)
- [Who the user is](#who-the-user-is)
- [Events of your own](#events-of-your-own)
- [Screens](#screens)
- [The visit](#the-visit)
- [Consent](#consent)
- [Delivery and failure](#delivery-and-failure)
- [Reference](#reference)

## Install

Flutter 3.22 or later, on Android, iOS or the web.

```bash
flutter pub add finic_kairos --git-url=https://github.com/finic-ai/kairos.git --git-path=packages/sdk-dart
```

## Start the client

Make a public key in **Settings › API keys**. Do not limit it to websites: an app sends no website address. Then make one client when the app starts:

```dart
import 'package:finic_kairos/finic_kairos.dart';

final kairos = Kairos(apiKey: 'kpk_…', environment: FlutterEnvironment());

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await kairos.start();
  KairosLifecycle.attach(kairos);
  runApp(const App());
}
```

`start` reads the device id and the client settings. Events wait in memory until the settings arrive. The client refuses a secret key (`ksk_…`): a secret key in an app can be read by anyone who has the app.

## Send the device to your server

The decisions are made on your server, with a secret key. For a decision to see the device of the app, send the device id with each request to your server, and name it as the `device` entity there:

```dart
final deviceId = await kairos.deviceId;
dio.options.headers['X-Device-Id'] = deviceId;
```

If the app already keeps an id for each install, give it to the client, so that the app, your server and Kairos use one id:

```dart
final kairos = Kairos(apiKey: 'kpk_…', environment: FlutterEnvironment(), deviceId: installId);
```

## Who the user is

After a sign-in, say who the user is. Every event after it names the user:

```dart
kairos.setContext(entities: {'user': user.id});
```

After a sign-out, remove the user:

```dart
kairos.setContext(entities: {'user': null});
```

The user id from an app can be changed by whoever holds the device. Kairos treats events from a public key as context, not as the only evidence: send what a decision depends on from your server.

## Events of your own

```dart
kairos.track('coupon_applied', properties: {'code': 'SPRING10'});
kairos.track('document_scanned', entities: {'document': doc.id}, properties: {'pages': 2});
```

Each event names the device and the entities of `setContext`, and has `source: "mobile"` in its properties. A public key cannot set entity properties.

## Screens

In **Settings › Integrations › Client settings**, name each screen to send and its event type, such as `checkout` → `checkout_viewed`. The client sends the event when that screen opens, with the facts of the device. It never sends the name of the device.

| Fact | Platforms | Value |
|---|---|---|
| `platform`, `model`, `os_version` | all | The device and its OS. Android also sends `sdk_int` and `manufacturer`. |
| `app_version`, `app_build`, `debug_build` | all | The app, and `true` for a debug build. |
| `install_source` | Android, iOS | The store that installed the app: `com.android.vending` (Google Play), `com.apple` (App Store), `com.apple.testflight`, `com.apple.simulator`, or `none` for an Android app that was not installed from a store. |
| `language`, `time_zone`, `screen` | all | The locale, the time zone and the screen size in pixels. |
| `physical_device` | Android, iOS | `false` on an emulator or a simulator. |
| `emulator_reasons` | Android | The parts of the build that look like an emulator, such as `fingerprint`, `hardware` or `product`. Empty on most real phones. `x86_abi` is also true on a Chromebook. |
| `test_keys` | Android | `true` when the OS is signed with test keys: a custom or rooted ROM. |
| `security_patch` | Android | The date of the last security patch, such as `2026-10-05`. |
| `ios_app_on_mac` | iOS | `true` when the iPhone app runs on a Mac. |

Add the observer to your navigator, and give your routes names:

```dart
MaterialApp(navigatorObservers: [KairosNavigatorObserver(kairos)]);
GoRouter(observers: [KairosNavigatorObserver(kairos)], routes: [GoRoute(name: 'checkout', path: '/checkout', builder: …)]);
```

Or send a screen yourself: `kairos.screen('checkout')`. A screen that the settings do not name sends nothing.

The client also sends `app_opened`, with the same facts, when the app starts and when it comes back after 30 minutes. Pass `trackAppOpens: false` to turn it off.

## The visit

An event with no session of its own is sent with the id of the visit: one visit of the app, which ends after 30 minutes with no event. To send the login session of your own system instead, give it to `setContext(session: …)`, or to one event with `session:`. `session: null` sends no session.

## Consent

When the client settings require consent, nothing is sent before `kairos.consent(true)`. `kairos.consent(false)` drops what is waiting.

## Delivery and failure

Events are sent when 20 are waiting or every 2 seconds, and when the app goes to the background (with `KairosLifecycle`). A batch that Kairos could not take is kept and sent again. A batch that Kairos rejects is dropped. The queue holds 1,000 events, and the oldest are dropped beyond that. `track` never fails because Kairos cannot be reached: errors go to `onError`.

```dart
final kairos = Kairos(apiKey: 'kpk_…', environment: FlutterEnvironment(), onError: (e) => log('kairos: $e'));
```

## Reference

| `Kairos(...)` | Default | |
|---|---|---|
| `apiKey` | required | A public key (`kpk_…`). |
| `environment` | required | `FlutterEnvironment()`, or your own `KairosEnvironment`. |
| `baseUrl` | `https://kairos.finic.ai` | The address of Kairos. |
| `deviceId` | an id kept in shared preferences | The id of this install. |
| `entities`, `session` | none | The same as `setContext`. |
| `flushInterval` | 2 seconds | `Duration.zero` sends only when 20 events wait and on `flush`. |
| `trackAppOpens` | `true` | Send `app_opened`. |
| `onError` | nothing | Called for delivery failures and settings that cannot be read. |

| Method | |
|---|---|
| `start()` | Reads the device id and the client settings. Safe to call more than once. |
| `deviceId` | The id of this install, as a `Future<String>`. |
| `track(type, {properties, entities, session, timestamp, eventId})` | Queues an event. |
| `screen(name, {properties})` | Sends the event of a screen that the settings name. Returns whether it did. |
| `setContext({entities, session})` | Who is acting from now on. A null id removes an entity. |
| `consent(given)` | Starts or stops sending. |
| `flush()` | Sends what is queued. |
| `dispose()` | Flushes, then refuses further events. |
