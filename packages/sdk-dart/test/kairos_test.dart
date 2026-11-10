import 'dart:convert';

import 'package:finic_kairos/src/environment.dart';
import 'package:finic_kairos/src/errors.dart';
import 'package:finic_kairos/src/kairos.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class FakeEnvironment extends KairosEnvironment {
  String? stored;
  DateTime clock = DateTime.utc(2026, 11, 6, 9);

  @override
  Future<String?> readDeviceId() async => stored;

  @override
  Future<void> writeDeviceId(String id) async => stored = id;

  @override
  Future<Map<String, Object?>> facts() async => {'platform': 'ios', 'app_version': '1.2.0'};

  @override
  DateTime now() => clock;
}

class Server {
  Server({this.settings = const {'version': 1, 'consent': 'not_required', 'screens': []}});

  Map<String, Object?> settings;
  int eventsStatus = 202;
  final List<Map<String, dynamic>> events = [];
  final List<http.Request> requests = [];

  MockClient get client => MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/v1/client-settings') {
          return http.Response(jsonEncode(settings), 200);
        }
        if (eventsStatus != 202) return http.Response('{"error":{}}', eventsStatus);
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        events.addAll((body['batch'] as List).cast<Map<String, dynamic>>());
        return http.Response('{"accepted":1}', 202);
      });
}

Future<void> settle() => Future<void>.delayed(Duration.zero);

void main() {
  Kairos build(Server server, FakeEnvironment env, {bool appOpens = false, List<Object>? errors}) =>
      Kairos(
        apiKey: 'kpk_test',
        baseUrl: 'http://localhost:8787/',
        environment: env,
        httpClient: server.client,
        trackAppOpens: appOpens,
        flushInterval: Duration.zero,
        onError: errors?.add,
      );

  test('refuses a secret key', () {
    expect(
      () => Kairos(apiKey: 'ksk_live', environment: FakeEnvironment()),
      throwsA(isA<KairosError>()),
    );
  });

  test('keeps one device id for an install and sends it with every event', () async {
    final env = FakeEnvironment();
    final server = Server();
    final kairos = build(server, env, appOpens: true);
    final id = await kairos.deviceId;
    expect(env.stored, id);

    kairos.setContext(entities: {'user': 'user_42'});
    kairos.track('coupon_applied', properties: {'code': 'SPRING10'});
    await settle();
    await kairos.flush();

    expect(server.events.map((e) => e['type']), ['app_opened', 'coupon_applied']);
    final coupon = server.events.last;
    expect(coupon['entities'], {'device': id, 'user': 'user_42'});
    expect(coupon['properties'], {'code': 'SPRING10', 'source': 'mobile'});
    expect(server.events.first['properties'], containsPair('platform', 'ios'));
    expect(server.requests.last.headers['authorization'], 'Bearer kpk_test');
    expect(server.requests.last.url.toString(), 'http://localhost:8787/v1/events');

    final again = build(Server(), env);
    expect(await again.deviceId, id);
  });

  test('uses a device id the app gives', () async {
    final kairos = Kairos(
      apiKey: 'kpk_test',
      environment: FakeEnvironment(),
      deviceId: 'app-device',
      httpClient: Server().client,
    );
    expect(await kairos.deviceId, 'app-device');
  });

  test('sends the visit as the session until the app gives one, and renews it after 30 minutes', () async {
    final env = FakeEnvironment();
    final server = Server();
    final kairos = build(server, env);
    await kairos.start();
    kairos.track('a');
    kairos.track('b');
    env.clock = env.clock.add(const Duration(minutes: 31));
    kairos.track('c');
    kairos.setContext(session: 'sess_1');
    kairos.track('d');
    kairos.track('e', session: null);
    await settle();
    await kairos.flush();

    final sessions = server.events.map((e) => e['session']).toList();
    expect(sessions[0], sessions[1]);
    expect(sessions[2], isNot(sessions[0]));
    expect(sessions[3], 'sess_1');
    expect(server.events[4].containsKey('session'), isFalse);
  });

  test('sends screen events only for screens the settings name', () async {
    final server = Server(settings: {
      'version': 2,
      'consent': 'not_required',
      'screens': [
        {'name': 'checkout', 'type': 'checkout_viewed'},
      ],
    });
    final kairos = build(server, FakeEnvironment());
    await kairos.start();
    await settle();
    expect(kairos.screen('home'), isFalse);
    expect(kairos.screen('checkout'), isTrue);
    await kairos.flush();
    expect(server.events.single['type'], 'checkout_viewed');
    expect(server.events.single['properties'], containsPair('screen', 'checkout'));
  });

  test('waits for consent when the settings require it', () async {
    final server = Server(settings: {'version': 1, 'consent': 'required', 'screens': []});
    final kairos = build(server, FakeEnvironment());
    await kairos.start();
    await settle();
    kairos.track('a');
    await kairos.flush();
    expect(server.events, isEmpty);
    kairos.consent(true);
    await settle();
    await kairos.flush();
    expect(server.events.single['type'], 'a');
  });

  test('keeps a batch the server could not take, and drops one it rejects', () async {
    final server = Server()..eventsStatus = 503;
    final errors = <Object>[];
    final kairos = build(server, FakeEnvironment(), errors: errors);
    await kairos.start();
    await settle();
    kairos.track('a');
    await kairos.flush();
    expect(server.events, isEmpty);
    expect(errors.single, isA<KairosApiError>());

    server.eventsStatus = 400;
    await kairos.flush();
    server.eventsStatus = 202;
    await kairos.flush();
    expect(server.events, isEmpty);
  });
}
