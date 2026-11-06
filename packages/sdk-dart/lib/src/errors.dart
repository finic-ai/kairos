class KairosError implements Exception {
  KairosError(this.message);

  final String message;

  @override
  String toString() => 'KairosError: $message';
}

class KairosApiError extends KairosError {
  KairosApiError(this.status, String body)
      : super('Kairos answered HTTP $status${body.isEmpty ? '' : ': $body'}');

  final int status;
}
