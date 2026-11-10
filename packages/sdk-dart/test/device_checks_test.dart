import 'package:finic_kairos/src/device_checks.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  List<String> reasons({
    String fingerprint = 'google/shiba/shiba:14/AP1A.240305.019.A1/11445699:user/release-keys',
    String hardware = 'shiba',
    String board = 'shiba',
    String model = 'Pixel 8',
    String manufacturer = 'Google',
    String brand = 'google',
    String device = 'shiba',
    String product = 'shiba',
    List<String> abis = const ['arm64-v8a'],
  }) =>
      androidEmulatorReasons(
        fingerprint: fingerprint,
        hardware: hardware,
        board: board,
        model: model,
        manufacturer: manufacturer,
        brand: brand,
        device: device,
        product: product,
        abis: abis,
      );

  test('a real phone gives no reasons', () {
    expect(reasons(), isEmpty);
  });

  test('the Android Studio emulator gives its reasons', () {
    expect(
      reasons(
        fingerprint:
            'google/sdk_gphone64_arm64/emu64a:14/UE1A.230829.019/10954474:userdebug/dev-keys',
        hardware: 'ranchu',
        board: 'goldfish_arm64',
        model: 'sdk_gphone64_arm64',
        device: 'emu64a',
        product: 'sdk_gphone64_arm64',
      ),
      ['fingerprint', 'hardware', 'board', 'model', 'device', 'product'],
    );
  });

  test('Genymotion and an x86 image give their reasons', () {
    expect(
      reasons(
        fingerprint: 'generic/vbox86p/vbox86p:11/RQ1A.210105.003/857:userdebug/test-keys',
        hardware: 'vbox86',
        manufacturer: 'Genymotion',
        brand: 'generic',
        device: 'generic_x86',
        product: 'vbox86p',
        abis: const ['x86_64', 'x86'],
      ),
      ['fingerprint', 'hardware', 'manufacturer', 'brand', 'device', 'product', 'x86_abi'],
    );
  });
}
