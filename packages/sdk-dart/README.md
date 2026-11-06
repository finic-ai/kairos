# finic_kairos

The [Kairos](https://kairos.finic.ai) client for Flutter apps. It gives each install a device id, sends the screens that your client settings name as events, and sends the events that you track. It uses a public key (`kpk_…`), which can only send events.

```dart
import 'package:finic_kairos/finic_kairos.dart';

final kairos = Kairos(apiKey: 'kpk_…', environment: FlutterEnvironment());

await kairos.start();
KairosLifecycle.attach(kairos);

dio.options.headers['X-Device-Id'] = await kairos.deviceId;
kairos.setContext(entities: {'user': user.id});
kairos.track('coupon_applied', properties: {'code': 'SPRING10'});
```

Decisions are made on your server with a secret key. Send the device id to your server and name it as the `device` entity there, so that a decision sees the device of the app.

The guide: [kairos.finic.ai/docs/reference/clients/dart](https://kairos.finic.ai/docs/reference/clients/dart).
