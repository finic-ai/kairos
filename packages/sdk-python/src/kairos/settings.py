"""The routes of the client settings: which route a request is for, and the properties of its event.

The same rules as the TypeScript SDK, so that a field reads the same in every client.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import unquote

#: HMAC-SHA-256 of a value with the customer's hash key, as hex.
Hash = Callable[[str], str]

#: The largest body that a collector reads for the fields of a route.
MAX_BODY_BYTES = 128 * 1024

_JSON = re.compile(r"^application/(?:[\w.+-]+\+)?json\b", re.IGNORECASE)


def readable_body(content_type: str | None, content_length: str | None) -> bool:
    """Whether a collector may read a body for the fields of a route.

    JSON only, so that a file upload is never read, and at most ``MAX_BODY_BYTES`` when the length is known.
    """
    if not _JSON.match((content_type or "").strip()):
        return False
    return content_length is None or (content_length.isdigit() and int(content_length) <= MAX_BODY_BYTES)


@dataclass
class RequestParts:
    """What a collector can read of a request, and of its response once there is one."""

    query: Callable[[str], str | None]
    header: Callable[[str], str | None]
    cookie: Callable[[str], str | None]
    params: dict[str, str] = field(default_factory=dict)
    body: Any = None
    response_header: Callable[[str], str | None] = lambda name: None


def _segments(path: str) -> list[str]:
    return [part for part in path.split("/") if part]


def match_path(pattern: str, path: str) -> dict[str, str] | None:
    """The values of the parameters of ``pattern`` in ``path``, or None when the path is not the pattern's."""
    want, have = _segments(pattern), _segments(path)
    params: dict[str, str] = {}
    for i, part in enumerate(want):
        if part == "*":
            return params
        if i >= len(have):
            return None
        if part.startswith(":"):
            params[part[1:]] = unquote(have[i])
        elif part != have[i]:
            return None
    return params if len(have) == len(want) else None


def match_route(settings: Mapping[str, Any], method: str, path: str) -> tuple[Mapping[str, Any], dict[str, str]] | None:
    """The first route of the settings for a request, with its parameters."""
    if settings.get("routing", {}).get("mode") == "off":
        return None
    verb = method.upper()
    for route in settings.get("routes", []):
        route_verb, _, pattern = str(route.get("route", "")).partition(" ")
        if route_verb != verb:
            continue
        params = match_path(pattern, path)
        if params is not None:
            return route, params
    return None


_STEP = re.compile(r"\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\['([^']*)'\]|\[\"([^\"]*)\"\]")


def read_path(value: Any, path: str) -> Any:
    """``$.payee.id``, ``$.items[0].sku``, ``$['first name']``: the part of JSONPath that names one value."""
    if not path.startswith("$"):
        return None
    at = value
    for key, index, quoted, doubled in _STEP.findall(path[1:]):
        if index:
            at = at[int(index)] if isinstance(at, list) and int(index) < len(at) else None
        else:
            at = at.get(key or quoted or doubled) if isinstance(at, Mapping) else None
        if at is None:
            return None
    return at


def is_card_number(value: Any) -> bool:
    """13 to 19 digits that pass the Luhn check: a card number, which no collector sends as it is."""
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return False
    digits = re.sub(r"[\s-]", "", str(value))
    if not re.fullmatch(r"\d{13,19}", digits):
        return False
    total = 0
    for i, char in enumerate(reversed(digits)):
        d = int(char)
        if i % 2 == 1:
            d = d * 2 - 9 if d * 2 > 9 else d * 2
        total += d
    return total % 10 == 0


_CODES = (
    "AD376 AE971 AF93 AG1 AI1 AL355 AM374 AO244 AR54 AS1 AT43 AU61 AW297 AX358 AZ994 BA387 BB1 BD880 BE32 BF226 "
    "BG359 BH973 BI257 BJ229 BL590 BM1 BN673 BO591 BQ599 BR55 BS1 BT975 BW267 BY375 BZ501 CA1 CD243 CF236 CG242 "
    "CH41 CI225 CK682 CL56 CM237 CN86 CO57 CR506 CU53 CV238 CW599 CY357 CZ420 DE49 DJ253 DK45 DM1 DO1 DZ213 EC593 "
    "EE372 EG20 ER291 ES34 ET251 FI358 FJ679 FK500 FM691 FO298 FR33 GA241 GB44 GD1 GE995 GF594 GG44 GH233 GI350 "
    "GL299 GM220 GN224 GP590 GQ240 GR30 GT502 GU1 GW245 GY592 HK852 HN504 HR385 HT509 HU36 ID62 IE353 IL972 IM44 "
    "IN91 IQ964 IR98 IS354 IT39 JE44 JM1 JO962 JP81 KE254 KG996 KH855 KI686 KM269 KN1 KP850 KR82 KW965 KY1 KZ7 "
    "LA856 LB961 LC1 LI423 LK94 LR231 LS266 LT370 LU352 LV371 LY218 MA212 MC377 MD373 ME382 MF590 MG261 MH692 "
    "MK389 ML223 MM95 MN976 MO853 MP1 MQ596 MR222 MS1 MT356 MU230 MV960 MW265 MX52 MY60 MZ258 NA264 NC687 NE227 "
    "NG234 NI505 NL31 NO47 NP977 NR674 NU683 NZ64 OM968 PA507 PE51 PF689 PG675 PH63 PK92 PL48 PM508 PR1 PS970 "
    "PT351 PW680 PY595 QA974 RE262 RO40 RS381 RU7 RW250 SA966 SB677 SC248 SD249 SE46 SG65 SH290 SI386 SK421 SL232 "
    "SM378 SN221 SO252 SR597 SS211 ST239 SV503 SX1 SY963 SZ268 TC1 TD235 TG228 TH66 TJ992 TK690 TL670 TM993 TN216 "
    "TO676 TR90 TT1 TV688 TW886 TZ255 UA380 UG256 US1 UY598 UZ998 VA39 VC1 VE58 VG1 VI1 VN84 VU678 WF681 WS685 "
    "XK383 YE967 YT262 ZA27 ZM260 ZW263"
)
_CALLING_CODES = {entry[:2]: entry[2:] for entry in _CODES.split()}
# Italy, San Marino and the Vatican keep the leading 0 of a national number in E.164.
_KEEPS_ZERO = {"IT", "SM", "VA"}


def normalize_phone(value: str, country: str | None = None) -> str:
    """E.164 where it can be: "07700 900123" with GB is "+447700900123"."""
    digits = re.sub(r"\D", "", value)
    if value.strip().startswith("+"):
        return f"+{digits}"
    if digits.startswith("00"):
        return f"+{digits[2:]}"
    code = _CALLING_CODES.get(country or "")
    if not code:
        return digits
    return f"+{code}{digits if country in _KEEPS_ZERO else digits.removeprefix('0')}"


def _normalize(kind: str, value: str, country: str | None) -> str:
    if kind in ("email", "username"):
        return value.strip().lower()
    if kind == "phone":
        return normalize_phone(value, country)
    if kind == "address":
        return " ".join(value.lower().split())
    return value


def _read(spec: Mapping[str, Any], parts: RequestParts) -> Any:
    path = str(spec.get("path", ""))
    source = spec.get("from")
    if source == "request.body":
        return read_path(parts.body, path)
    if source == "request.query":
        return parts.query(path)
    if source == "request.header":
        return parts.header(path)
    if source == "request.cookie":
        return parts.cookie(path)
    if source == "request.param":
        return parts.params.get(path)
    if source == "response.header":
        return parts.response_header(path)
    return None


def route_properties(route: Mapping[str, Any], parts: RequestParts, settings: Mapping[str, Any], hash: Hash | None = None) -> tuple[dict[str, Any], list[str]]:
    """The properties of a route's event, read from the request as its ``fields`` say, and the problems.

    A field with nothing to read is left out, and so is one of a kind that ``defaults.off`` turns
    off, and a card number. A problem is what could not be done, such as a hash without a hash key.
    """
    defaults = settings.get("defaults", {})
    off = set(defaults.get("off", []))
    properties: dict[str, Any] = {}
    problems: list[str] = []
    for name, spec in route.get("fields", {}).items():
        if "value" in spec:
            properties[name] = spec["value"]
            continue
        kind = spec.get("kind")
        if kind in off:
            continue
        raw = _read(spec, parts)
        if raw is None or raw == "":
            continue
        # A cookie is a credential, so it is sent only as a hash.
        if kind == "hmac" or spec.get("from") == "request.cookie":
            if hash is None:
                problems.append(f'{route["route"]}: the field "{name}" is sent only as a hash, and there is no hash key.')
            else:
                properties[name] = hash(str(raw))
            continue
        if kind == "token":
            properties[name] = raw
            continue
        if is_card_number(raw):
            continue
        if kind:
            if isinstance(raw, bool) or not isinstance(raw, (str, int, float)):
                continue
            properties[name] = _normalize(kind, str(raw), defaults.get("country"))
        else:
            properties[name] = raw
    return properties, problems
