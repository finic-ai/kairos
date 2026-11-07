/// The parts of an Android build that look like an emulator. A reason is a hint, not proof:
/// `x86_abi` is also true on a Chromebook.
List<String> androidEmulatorReasons({
  required String fingerprint,
  required String hardware,
  required String board,
  required String model,
  required String manufacturer,
  required String brand,
  required String device,
  required String product,
  required List<String> abis,
}) {
  bool any(String value, List<String> parts) {
    final lower = value.toLowerCase();
    return parts.any(lower.contains);
  }

  final f = fingerprint.toLowerCase();
  return [
    if (f.startsWith('generic') ||
        f.startsWith('unknown') ||
        any(f, ['sdk_gphone', 'emulator', 'vbox86']))
      'fingerprint',
    if (any(hardware, ['goldfish', 'ranchu', 'vbox86'])) 'hardware',
    if (any(board, ['goldfish', 'ranchu'])) 'board',
    if (any(model, ['google_sdk', 'emulator', 'android sdk built for', 'sdk_gphone'])) 'model',
    if (any(manufacturer, ['genymotion'])) 'manufacturer',
    if (brand.toLowerCase().startsWith('generic') && device.toLowerCase().startsWith('generic'))
      'brand',
    if (any(device, ['emu64', 'vbox86']) || device.toLowerCase().startsWith('generic_x86'))
      'device',
    if (any(product, ['sdk_gphone', 'google_sdk', 'sdk_x86', 'sdk_google', 'vbox86p', 'emulator', 'simulator']))
      'product',
    if (abis.isNotEmpty && abis.every((abi) => abi.startsWith('x86'))) 'x86_abi',
  ];
}
