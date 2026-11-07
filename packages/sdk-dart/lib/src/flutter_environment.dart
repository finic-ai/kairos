import 'dart:io' show Platform;
import 'dart:ui' show PlatformDispatcher;

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart' show kDebugMode, kIsWeb;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'device_checks.dart';
import 'environment.dart';

/// The device of a Flutter app: the device id in shared preferences, and the facts from
/// `device_info_plus` and `package_info_plus`. Never the name of the device or the user.
class FlutterEnvironment extends KairosEnvironment {
  FlutterEnvironment({this.storageKey = 'kairos.device_id'});

  final String storageKey;

  @override
  Future<String?> readDeviceId() async =>
      (await SharedPreferences.getInstance()).getString(storageKey);

  @override
  Future<void> writeDeviceId(String id) async =>
      (await SharedPreferences.getInstance()).setString(storageKey, id);

  @override
  Future<Map<String, Object?>> facts() async {
    final dispatcher = PlatformDispatcher.instance;
    final view = dispatcher.views.isEmpty ? null : dispatcher.views.first;
    final package = await PackageInfo.fromPlatform();
    return {
      'app_version': package.version,
      'app_build': package.buildNumber,
      // Android gives no store for a sideloaded or adb install.
      if (!kIsWeb) 'install_source': package.installerStore ?? 'none',
      'debug_build': kDebugMode,
      'language': dispatcher.locale.toLanguageTag(),
      'time_zone': DateTime.now().timeZoneName,
      if (view != null)
        'screen': '${view.physicalSize.width.round()}x${view.physicalSize.height.round()}',
      ...await _device(),
    };
  }

  Future<Map<String, Object?>> _device() async {
    if (kIsWeb) return {'platform': 'web'};
    final info = DeviceInfoPlugin();
    if (Platform.isAndroid) {
      final android = await info.androidInfo;
      return {
        'platform': 'android',
        'os_version': android.version.release,
        'sdk_int': android.version.sdkInt,
        'model': android.model,
        'manufacturer': android.manufacturer,
        // An emulator is a strong signal for an app that only people should use.
        'physical_device': android.isPhysicalDevice,
        'emulator_reasons': androidEmulatorReasons(
          fingerprint: android.fingerprint,
          hardware: android.hardware,
          board: android.board,
          model: android.model,
          manufacturer: android.manufacturer,
          brand: android.brand,
          device: android.device,
          product: android.product,
          abis: android.supportedAbis,
        ),
        // Store builds are signed with release-keys; test-keys means a custom or rooted ROM.
        'test_keys': android.tags.contains('test-keys'),
        if (android.version.securityPatch != null)
          'security_patch': android.version.securityPatch,
      };
    }
    if (Platform.isIOS) {
      final ios = await info.iosInfo;
      return {
        'platform': 'ios',
        'os_version': ios.systemVersion,
        'model': ios.utsname.machine,
        'physical_device': ios.isPhysicalDevice,
        'ios_app_on_mac': ios.isiOSAppOnMac,
      };
    }
    return {'platform': Platform.operatingSystem, 'os_version': Platform.operatingSystemVersion};
  }
}
