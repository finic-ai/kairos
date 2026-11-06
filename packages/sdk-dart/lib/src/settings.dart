/// The part of the client settings that a public key reads.
class KairosSettings {
  const KairosSettings({
    required this.version,
    required this.consentRequired,
    required this.screens,
  });

  factory KairosSettings.fromJson(Map<String, dynamic> json) {
    final screens = <String, String>{};
    for (final screen in (json['screens'] as List? ?? const [])) {
      if (screen is Map && screen['name'] is String && screen['type'] is String) {
        screens[screen['name'] as String] = screen['type'] as String;
      }
    }
    return KairosSettings(
      version: (json['version'] as num?)?.toInt() ?? 0,
      consentRequired: json['consent'] == 'required',
      screens: screens,
    );
  }

  final int version;
  final bool consentRequired;

  /// Screen name → the event type it sends.
  final Map<String, String> screens;
}
