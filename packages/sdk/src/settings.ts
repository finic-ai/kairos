import type { ClientRoute, ClientSettings, EventProperties, FieldKind, RouteField } from "./types.js";

/** What a collector can read of a request, and of its response once there is one. */
export interface RequestParts {
  body?: unknown;
  query(name: string): string | undefined;
  header(name: string): string | undefined;
  cookie(name: string): string | undefined;
  params: Record<string, string>;
  responseHeader?(name: string): string | undefined;
}

/** HMAC-SHA-256 of a value with the customer's hash key, as hex. Each runtime brings its own. */
export type Hash = (value: string) => string | Promise<string>;

/** The largest body that a collector reads for the fields of a route. */
export const MAX_BODY_BYTES = 128 * 1024;

/**
 * Whether a collector may read a body for the fields of a route: JSON only, so that a file upload
 * is never read, and at most `MAX_BODY_BYTES` when the length is known.
 */
export function readableBody(contentType: string | undefined, contentLength: string | undefined): boolean {
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType?.trim() ?? "")) return false;
  return contentLength === undefined || Number(contentLength) <= MAX_BODY_BYTES;
}

const segments = (path: string) => path.split("/").filter(Boolean);

/** The values of the parameters of `pattern` in `path`, or undefined when the path is not the pattern's. */
export function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const want = segments(pattern);
  const have = segments(path);
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    if (part === "*") return params;
    const value = have[i];
    if (value === undefined) return undefined;
    if (part.startsWith(":")) {
      try {
        params[part.slice(1)] = decodeURIComponent(value);
      } catch {
        params[part.slice(1)] = value;
      }
    } else if (part !== value) return undefined;
  }
  return have.length === want.length ? params : undefined;
}

/** The first route of the settings for a request, with its parameters. */
export function matchRoute(
  settings: ClientSettings,
  method: string,
  path: string,
): { route: ClientRoute; params: Record<string, string> } | undefined {
  if (settings.routing.mode === "off") return undefined;
  const verb = method.toUpperCase();
  for (const route of settings.routes) {
    const [routeVerb, pattern] = route.route.split(" ");
    if (routeVerb !== verb) continue;
    const params = matchPath(pattern!, path);
    if (params) return { route, params };
  }
  return undefined;
}

/** `$.payee.id`, `$.items[0].sku`, `$['first name']`: the part of JSONPath that names one value. */
export function readPath(value: unknown, path: string): unknown {
  if (!path.startsWith("$")) return undefined;
  let at = value;
  for (const [, key, index, quoted, doubled] of path
    .slice(1)
    .matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]/g)) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[key ?? index ?? quoted ?? doubled!];
  }
  return at;
}

function read(field: RouteField, parts: RequestParts): unknown {
  const path = field.path!;
  switch (field.from) {
    case "request.body":
      return readPath(parts.body, path);
    case "request.query":
      return parts.query(path);
    case "request.header":
      return parts.header(path);
    case "request.cookie":
      return parts.cookie(path);
    case "request.param":
      return parts.params[path];
    case "response.header":
      return parts.responseHeader?.(path);
    default:
      return undefined;
  }
}

/** 13 to 19 digits that pass the Luhn check: a card number, which no collector sends as it is. */
export function isCardNumber(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const digits = String(value).replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

const CALLING_CODES = Object.fromEntries(
  (
    "AD376 AE971 AF93 AG1 AI1 AL355 AM374 AO244 AR54 AS1 AT43 AU61 AW297 AX358 AZ994 BA387 BB1 BD880 BE32 BF226 " +
    "BG359 BH973 BI257 BJ229 BL590 BM1 BN673 BO591 BQ599 BR55 BS1 BT975 BW267 BY375 BZ501 CA1 CD243 CF236 CG242 " +
    "CH41 CI225 CK682 CL56 CM237 CN86 CO57 CR506 CU53 CV238 CW599 CY357 CZ420 DE49 DJ253 DK45 DM1 DO1 DZ213 EC593 " +
    "EE372 EG20 ER291 ES34 ET251 FI358 FJ679 FK500 FM691 FO298 FR33 GA241 GB44 GD1 GE995 GF594 GG44 GH233 GI350 " +
    "GL299 GM220 GN224 GP590 GQ240 GR30 GT502 GU1 GW245 GY592 HK852 HN504 HR385 HT509 HU36 ID62 IE353 IL972 IM44 " +
    "IN91 IQ964 IR98 IS354 IT39 JE44 JM1 JO962 JP81 KE254 KG996 KH855 KI686 KM269 KN1 KP850 KR82 KW965 KY1 KZ7 " +
    "LA856 LB961 LC1 LI423 LK94 LR231 LS266 LT370 LU352 LV371 LY218 MA212 MC377 MD373 ME382 MF590 MG261 MH692 " +
    "MK389 ML223 MM95 MN976 MO853 MP1 MQ596 MR222 MS1 MT356 MU230 MV960 MW265 MX52 MY60 MZ258 NA264 NC687 NE227 " +
    "NG234 NI505 NL31 NO47 NP977 NR674 NU683 NZ64 OM968 PA507 PE51 PF689 PG675 PH63 PK92 PL48 PM508 PR1 PS970 " +
    "PT351 PW680 PY595 QA974 RE262 RO40 RS381 RU7 RW250 SA966 SB677 SC248 SD249 SE46 SG65 SH290 SI386 SK421 SL232 " +
    "SM378 SN221 SO252 SR597 SS211 ST239 SV503 SX1 SY963 SZ268 TC1 TD235 TG228 TH66 TJ992 TK690 TL670 TM993 TN216 " +
    "TO676 TR90 TT1 TV688 TW886 TZ255 UA380 UG256 US1 UY598 UZ998 VA39 VC1 VE58 VG1 VI1 VN84 VU678 WF681 WS685 " +
    "XK383 YE967 YT262 ZA27 ZM260 ZW263"
  )
    .split(" ")
    .map((entry) => [entry.slice(0, 2), entry.slice(2)]),
);
// Italy, San Marino and the Vatican keep the leading 0 of a national number in E.164.
const KEEPS_ZERO = new Set(["IT", "SM", "VA"]);

/** E.164 where it can be: "07700 900123" with GB is "+447700900123". */
export function normalizePhone(value: string, country?: string): string {
  const digits = value.replace(/\D/g, "");
  if (value.trim().startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  const code = country && CALLING_CODES[country];
  if (!code) return digits;
  return `+${code}${KEEPS_ZERO.has(country!) ? digits : digits.replace(/^0/, "")}`;
}

function normalize(kind: FieldKind | undefined, value: string, country?: string): string {
  switch (kind) {
    case "email":
    case "username":
      return value.trim().toLowerCase();
    case "phone":
      return normalizePhone(value, country);
    case "address":
      return value.trim().toLowerCase().replace(/\s+/g, " ");
    default:
      return value;
  }
}

/**
 * The properties of a route's event, read from the request as its `fields` say. A field with
 * nothing to read is left out, and so is one of a kind that `defaults.off` turns off, and a card
 * number. `problems` says what could not be done, such as a hash without a hash key.
 */
export async function routeProperties(
  route: ClientRoute,
  parts: RequestParts,
  settings: ClientSettings,
  hash?: Hash,
): Promise<{ properties: EventProperties; problems: string[] }> {
  const properties: EventProperties = {};
  const problems: string[] = [];
  const off = new Set<string>(settings.defaults.off);
  for (const [name, field] of Object.entries(route.fields)) {
    if (field.value !== undefined) {
      properties[name] = field.value;
      continue;
    }
    if (field.kind && off.has(field.kind)) continue;
    const raw = read(field, parts);
    if (raw === undefined || raw === null || raw === "") continue;
    // A cookie is a credential, so it is sent only as a hash.
    if (field.kind === "hmac" || field.from === "request.cookie") {
      if (!hash) {
        problems.push(`${route.route}: the field "${name}" is sent only as a hash, and there is no hash key.`);
        continue;
      }
      properties[name] = await hash(String(raw));
      continue;
    }
    if (field.kind === "token") {
      properties[name] = raw;
      continue;
    }
    if (isCardNumber(raw)) continue;
    if (field.kind) {
      if (typeof raw !== "string" && typeof raw !== "number") continue;
      properties[name] = normalize(field.kind, String(raw), settings.defaults.country);
    } else properties[name] = raw;
  }
  return { properties, problems };
}
