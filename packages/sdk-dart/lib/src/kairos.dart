import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'environment.dart';
import 'errors.dart';
import 'settings.dart';

const _flushAt = 20;
const _maxBatch = 500;
const _maxQueue = 1000;
const _retryable = {408, 429, 500, 502, 503, 504};
const _settingsRetry = Duration(seconds: 60);
const _visitTimeout = Duration(minutes: 30);

/// Leaves a value of [Kairos.track] or [Kairos.setContext] as it is.
const Object _unset = Object();

/// The Kairos client for a mobile app. It gives each install a device id, sends the screen
/// events of the client settings, and sends what you [track]. With a public key only.
///
///     final kairos = Kairos(apiKey: 'kpk_…', environment: FlutterEnvironment());
///     await kairos.start();
///     kairos.track('coupon_applied', properties: {'code': 'SPRING10'});
class Kairos {
  Kairos({
    required String apiKey,
    required KairosEnvironment environment,
    String baseUrl = 'https://kairos.finic.ai',
    String? deviceId,
    Map<String, String?> entities = const {},
    String? session,
    this.flushInterval = const Duration(seconds: 2),
    this.trackAppOpens = true,
    void Function(Object error)? onError,
    http.Client? httpClient,
  })  : _apiKey = apiKey,
        _env = environment,
        _baseUrl = baseUrl.replaceAll(RegExp(r'/+$'), ''),
        _deviceId = deviceId,
        _entities = {...entities},
        _session = session,
        _onError = onError ?? ((_) {}),
        _http = httpClient ?? http.Client() {
    if (apiKey.isEmpty) throw KairosError('apiKey is required');
    if (apiKey.startsWith('ksk_')) {
      throw KairosError(
        'A secret key (ksk_) must never be in an app. Use a public key (kpk_).',
      );
    }
  }

  final String _apiKey;
  final KairosEnvironment _env;
  final String _baseUrl;
  final Duration flushInterval;
  final bool trackAppOpens;
  final void Function(Object error) _onError;
  final http.Client _http;

  String? _deviceId;
  final Map<String, String?> _entities;
  String? _session;
  KairosSettings? _settings;
  bool? _consented;
  final List<Map<String, Object?>> _queue = [];
  Timer? _timer;
  Timer? _settingsTimer;
  Future<void>? _flushing;
  Future<void>? _starting;
  String? _visit;
  DateTime? _lastActivity;
  Map<String, Object?>? _facts;
  bool _disposed = false;

  /// The settings read from Kairos, or null until they are read.
  KairosSettings? get settings => _settings;

  /// The id of this install. Send it to your server, for example in an `X-Device-Id` header,
  /// so that the decisions of your server see the same device.
  Future<String> get deviceId async {
    await start();
    return _deviceId!;
  }

  /// Reads the device id and the client settings. Safe to call more than once.
  Future<void> start() => _starting ??= _start();

  Future<void> _start() async {
    try {
      _deviceId ??= await _env.readDeviceId();
    } catch (error) {
      _onError(error);
    }
    if (_deviceId == null) {
      _deviceId = newId();
      try {
        await _env.writeDeviceId(_deviceId!);
      } catch (error) {
        _onError(error);
      }
    }
    try {
      _facts = await _env.facts();
    } catch (error) {
      _onError(error);
      _facts = const {};
    }
    if (trackAppOpens) _trackAppOpened();
    unawaited(_loadSettings());
  }

  /// Records an event. It is sent in a batch, once the settings and consent allow.
  ///
  /// [session] is the login session of your own system; leave it out to send the visit of the
  /// app, or pass null for no session.
  void track(
    String type, {
    Map<String, Object?> properties = const {},
    Map<String, String?> entities = const {},
    Object? session = _unset,
    DateTime? timestamp,
    String? eventId,
  }) {
    if (_disposed) throw KairosError('track after dispose');
    if (type.isEmpty) throw KairosError('An event needs a type');
    _touch();
    // With no session of its own, an event is sent with the visit of the app.
    final chosen = identical(session, _unset) ? (_session ?? (_visit ??= newId())) : session as String?;
    _queue.add({
      'id': eventId ?? newId(),
      'type': type,
      'ts': (timestamp ?? _env.now()).toUtc().toIso8601String(),
      'entities': _compact({..._entities, ...entities}),
      'properties': {...properties, 'source': 'mobile'},
      if (chosen != null && chosen.isNotEmpty) 'session': chosen,
    });
    if (_queue.length > _maxQueue) _queue.removeRange(0, _queue.length - _maxQueue);
    if (_queue.length >= _flushAt) {
      unawaited(flush());
    } else {
      _schedule();
    }
  }

  /// Sends the event of a screen when the client settings name it. Returns whether one was sent.
  bool screen(String name, {Map<String, Object?> properties = const {}}) {
    final type = _settings?.screens[name];
    if (type == null) return false;
    track(type, properties: {'screen': name, ...?_facts, ...properties});
    return true;
  }

  /// Says who is acting from now on, for example after a sign-in. A null id removes an entity.
  void setContext({Map<String, String?> entities = const {}, Object? session = _unset}) {
    _entities.addAll(entities);
    if (!identical(session, _unset)) _session = session as String?;
  }

  /// Starts or stops sending. With consent required in the settings, nothing is sent before
  /// `consent(true)`. `consent(false)` drops what is waiting.
  void consent(bool given) {
    _consented = given;
    if (given) {
      unawaited(flush());
    } else {
      _queue.clear();
    }
  }

  /// Call when the app goes to the background: sends what is queued.
  Future<void> paused() => flush();

  /// Call when the app comes back. A return after 30 minutes starts a new visit.
  void resumed() {
    final last = _lastActivity;
    if (trackAppOpens && last != null && _env.now().difference(last) >= _visitTimeout) {
      _trackAppOpened();
    }
  }

  /// Sends what is queued, if the settings and consent allow. Never throws.
  Future<void> flush() {
    _timer?.cancel();
    _timer = null;
    return _flushing ??= _drain().whenComplete(() => _flushing = null);
  }

  /// Flushes, then refuses further events.
  Future<void> dispose() async {
    await flush();
    _disposed = true;
    _timer?.cancel();
    _settingsTimer?.cancel();
    _http.close();
  }

  bool get _allowed {
    final settings = _settings;
    if (settings == null || _deviceId == null) return false;
    return _consented ?? !settings.consentRequired;
  }

  Future<void> _drain() async {
    while (_allowed && _queue.isNotEmpty) {
      final waiting = _queue.sublist(0, _queue.length < _maxBatch ? _queue.length : _maxBatch);
      _queue.removeRange(0, waiting.length);
      final batch = [
        for (final event in waiting)
          {
            ...event,
            'entities': {'device': _deviceId, ...(event['entities'] as Map)},
          },
      ];
      try {
        final response = await _http.post(
          Uri.parse('$_baseUrl/v1/events'),
          headers: {
            'Authorization': 'Bearer $_apiKey',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({'batch': batch}),
        );
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw KairosApiError(response.statusCode, _short(response.body));
        }
      } catch (error) {
        // A rejected batch will be rejected again, so it is dropped.
        if (error is! KairosApiError || _retryable.contains(error.status)) {
          _queue.insertAll(0, waiting);
          _schedule();
        }
        _onError(error);
        return;
      }
    }
  }

  Future<void> _loadSettings() async {
    try {
      final response = await _http.get(
        Uri.parse('$_baseUrl/v1/client-settings'),
        headers: {'Authorization': 'Bearer $_apiKey'},
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw KairosApiError(response.statusCode, _short(response.body));
      }
      _settings = KairosSettings.fromJson(jsonDecode(response.body) as Map<String, dynamic>);
    } catch (error) {
      _onError(error);
      if (!_disposed) _settingsTimer = Timer(_settingsRetry, () => unawaited(_loadSettings()));
      return;
    }
    unawaited(flush());
  }

  void _trackAppOpened() => track('app_opened', properties: {...?_facts});

  void _touch() {
    final now = _env.now();
    final last = _lastActivity;
    if (last != null && now.difference(last) >= _visitTimeout) _visit = null;
    _lastActivity = now;
  }

  void _schedule() {
    if (_timer != null || flushInterval <= Duration.zero || _disposed) return;
    _timer = Timer(flushInterval, () {
      _timer = null;
      unawaited(flush());
    });
  }
}

Map<String, String> _compact(Map<String, String?> entities) => {
      for (final entry in entities.entries)
        if (entry.value != null && entry.value!.trim().isNotEmpty) entry.key: entry.value!.trim(),
    };

String _short(String body) => body.length > 500 ? body.substring(0, 500) : body;
