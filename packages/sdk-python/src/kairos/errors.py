from __future__ import annotations


class KairosError(Exception):
    """Any error from the Kairos client. An invalid call raises this directly."""


class KairosApiError(KairosError):
    """The API answered with an error status."""

    def __init__(self, status: int, body: str = "", request_id: str | None = None) -> None:
        super().__init__(f"Kairos API returned {status}{': ' + body if body else ''}")
        self.status = status
        self.body = body
        self.request_id = request_id


class KairosTimeoutError(KairosError):
    """No answer arrived inside the time limit."""

    def __init__(self, timeout: float) -> None:
        super().__init__(f"Kairos did not answer in {round(timeout * 1000)} ms")
        self.timeout = timeout
