import { COLUMN_FORMATS, validateFacts, validateLists, type EntityFact, type EntityList } from "./facts";

/**
 * What an entity type is. Defining a type is optional: an event that names a type no one
 * defined still creates it. A definition says what the type means, which properties it
 * carries, and whether sharing one links two subjects.
 */
export interface EntityDefinition {
  /** The entity type, for example "merchant". */
  type: string;
  /**
   * What sort of thing this type is, in Kairos's own vocabulary: see `KINDS`. Optional, and
   * any name is accepted. It classifies the type for people and for Kairos; it is not shown
   * to the model, because doing so made link detection worse in testing.
   */
  kind?: string;
  description?: string;
  /** Properties an entity of this type carries, as name → what it means. Documentation, not a constraint. */
  properties?: Record<string, string>;
  /**
   * Whether two subjects that share an entity of this type count as linked. Default true.
   * Set it to false for a type that many unrelated subjects share and that should never
   * connect them. An action's `linkTypes` overrides it.
   */
  link?: boolean;
  /** How people see the type and its entities in the console. Not shown to the model. */
  display?: EntityDisplay;
  facts?: EntityFact[];
  lists?: EntityList[];
}

export interface EntityDisplay {
  /** One of `ENTITY_ICONS`. Without it, the icon of the type's kind. */
  icon?: EntityIcon;
  /** One of `ENTITY_COLORS`. Without it, the colour of the type's kind. */
  color?: EntityColor;
  /** The properties that name an entity, in order and joined by a space: ["first_name", "last_name"]. Without them, its id. */
  fields?: string[];
  /** How a property shows, by its name: an image, a document, a link, money. Without one, as its value. */
  formats?: Record<string, PropertyFormat>;
}

export const PROPERTY_FORMATS = [...COLUMN_FORMATS, "image", "document", "link"] as const;
export type PropertyFormat = (typeof PROPERTY_FORMATS)[number];
const MAX_FORMATS = 100;

export const ENTITY_ICONS = [
  "person",
  "people",
  "business",
  "store",
  "card",
  "bank",
  "wallet",
  "banknote",
  "arrow_in",
  "arrow_out",
  "device",
  "phone",
  "mail",
  "document",
  "fingerprint",
  "globe",
  "link",
  "pin",
  "home",
  "flag",
  "hospital",
  "stethoscope",
  "flask",
  "shield",
  "scales",
  "wrench",
  "tag",
  "box",
  "car",
  "receipt",
] as const;
export type EntityIcon = (typeof ENTITY_ICONS)[number];

export const ENTITY_COLORS = ["gray", "blue", "teal", "green", "amber", "orange", "red", "pink", "purple"] as const;
export type EntityColor = (typeof ENTITY_COLORS)[number];

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * The kinds Kairos knows. `shared` says what it means when two unrelated subjects use the
 * same entity of this kind: "unusual" for something one party normally controls, "common"
 * for somewhere many unrelated parties go. This is the difference between a shared phone
 * and a shared supermarket.
 */
export const KINDS = {
  person: { is: "A human being", shared: "unusual" },
  business: { is: "An organisation", shared: "unusual" },
  account: { is: "Something that holds money: a bank account, a card, a wallet", shared: "unusual" },
  device: { is: "A phone, a computer or a browser", shared: "unusual" },
  contact: { is: "A way to reach a party: an email address, a phone number", shared: "unusual" },
  document: { is: "A proof of identity: a passport, a tax number", shared: "unusual" },
  network: { is: "A network location, such as an IP address", shared: "common" },
  place: { is: "A physical or commercial location: an ATM, a branch, a shop", shared: "common" },
  other: { is: "None of the above", shared: "unknown" },
} as const satisfies Record<string, { is: string; shared: "unusual" | "common" | "unknown" }>;

export type KnownKind = keyof typeof KINDS;

export const isKnownKind = (kind: string | undefined): kind is KnownKind =>
  kind !== undefined && Object.hasOwn(KINDS, kind);

const HINTS: [KnownKind, RegExp][] = [
  ["device", /device|phone_?id|browser|fingerprint/],
  ["network", /^ip$|ip_?address|network|asn/],
  ["contact", /email|phone|msisdn|contact/],
  ["document", /passport|ssn|tax|national_?id|document|licen[cs]e/],
  ["account", /account|card|wallet|iban|address$|destination|payee|beneficiary|recipient|sender/],
  ["place", /atm|branch|shop|store|location|venue|terminal|city|website|domain/],
  ["business", /merchant|seller|business|company|employer|vendor|organi[sz]ation|partner/],
  ["person", /user|customer|person|owner|rider|driver|borrower|member|applicant|agent/],
];

/** A likely kind for a type name, or undefined. A suggestion for a person to confirm, never applied by itself. */
export function suggestKind(type: string): KnownKind | undefined {
  const name = type.toLowerCase();
  return HINTS.find(([, pattern]) => pattern.test(name))?.[0];
}

const KIND_DISPLAY: Record<KnownKind, { icon: EntityIcon; color: EntityColor }> = {
  person: { icon: "person", color: "blue" },
  business: { icon: "business", color: "purple" },
  account: { icon: "card", color: "green" },
  device: { icon: "device", color: "teal" },
  contact: { icon: "mail", color: "amber" },
  document: { icon: "document", color: "orange" },
  network: { icon: "globe", color: "gray" },
  place: { icon: "pin", color: "red" },
  other: { icon: "tag", color: "gray" },
};

/** The icon and the colour of a type: its own, or else those of its kind, or of the kind its name suggests. */
export function displayOf(type: string, definition?: Pick<EntityDefinition, "kind" | "display"> | null) {
  const kind = definition?.kind ?? suggestKind(type);
  const fallback = isKnownKind(kind) ? KIND_DISPLAY[kind] : KIND_DISPLAY.other;
  return {
    icon: definition?.display?.icon ?? fallback.icon,
    color: definition?.display?.color ?? fallback.color,
    fields: definition?.display?.fields ?? [],
  };
}

/** The name of one entity for people, from the display fields that it has. Undefined when it has none of them. */
export function displayName(fields: string[] | undefined, properties: Record<string, unknown>): string | undefined {
  const parts = (fields ?? [])
    .map((field) => properties[field])
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map((value) => (typeof value === "object" ? JSON.stringify(value) : String(value)).trim());
  return parts.length ? parts.join(" ") : undefined;
}

/** Returns a list of problems; empty when the definition is usable. */
export function validateEntity(definition: EntityDefinition): string[] {
  const problems: string[] = [];
  if (!NAME.test(definition.type ?? "")) problems.push("type must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$");
  if (definition.description !== undefined && typeof definition.description !== "string")
    problems.push("description must be text");
  if (definition.kind !== undefined && !NAME.test(definition.kind))
    problems.push('kind must be a name such as "person" or "device"');
  if (definition.link !== undefined && typeof definition.link !== "boolean")
    problems.push("link must be true or false");
  if (definition.properties !== undefined) {
    if (
      typeof definition.properties !== "object" ||
      definition.properties === null ||
      Array.isArray(definition.properties)
    ) {
      problems.push("properties must map a property name to its description");
    } else {
      for (const [name, text] of Object.entries(definition.properties)) {
        if (!NAME.test(name)) problems.push(`properties.${name}: name must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$`);
        if (typeof text !== "string" || !text.trim())
          problems.push(`properties.${name}: description must not be blank`);
      }
    }
  }
  const display = definition.display;
  if (display !== undefined) {
    if (typeof display !== "object" || display === null || Array.isArray(display)) {
      problems.push("display must be an object of icon, color and fields");
    } else {
      if (display.icon !== undefined && !ENTITY_ICONS.includes(display.icon))
        problems.push(`display.icon must be one of ${ENTITY_ICONS.join(", ")}`);
      if (display.color !== undefined && !ENTITY_COLORS.includes(display.color))
        problems.push(`display.color must be one of ${ENTITY_COLORS.join(", ")}`);
      if (
        display.fields !== undefined &&
        (!Array.isArray(display.fields) ||
          display.fields.length > 4 ||
          display.fields.some((field) => typeof field !== "string" || !NAME.test(field)))
      )
        problems.push("display.fields must be up to 4 property names");
      const formats = display.formats;
      if (formats !== undefined) {
        if (!formats || typeof formats !== "object" || Array.isArray(formats))
          problems.push("display.formats must map a property name to its format");
        else {
          if (Object.keys(formats).length > MAX_FORMATS) problems.push(`display.formats: at most ${MAX_FORMATS}`);
          for (const [name, format] of Object.entries(formats)) {
            if (!NAME.test(name))
              problems.push(`display.formats.${name}: name must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$`);
            if (!PROPERTY_FORMATS.includes(format))
              problems.push(`display.formats.${name} must be one of ${PROPERTY_FORMATS.join(", ")}`);
          }
        }
      }
    }
  }
  problems.push(...validateFacts(definition.facts), ...validateLists(definition.lists));
  return problems;
}
