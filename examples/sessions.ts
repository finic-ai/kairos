/**
 * Sessions with several decisions in each: six customers, one visit each, and in every visit
 * Kairos is asked more than once. Some visits are ordinary from start to end. Some start
 * well and turn: a session that is taken over half way, a customer who is talked into
 * sending money, a new account that fills up and empties.
 *
 *   GRAYSON_API_KEY=... pnpm api         with KAIROS_API_KEY in .env: a secret key from the console (Settings › API keys)
 *   pnpm example:sessions
 *
 * Four actions are defined, each started by its own event: a sign-in, a change to the
 * profile, a new payee and a transfer. Every event carries `$session`, so each decision sees
 * what happened in its visit before it. The outcomes are the model's own: nothing here says
 * what to answer.
 */
import { Kairos, type ActionDefinition, type EventProperties } from "../packages/sdk/src/index.js";

const kairos = new Kairos({
  apiKey: process.env.KAIROS_API_KEY ?? missingKey(),
  baseUrl: process.env.KAIROS_URL || "http://localhost:8787",
  decideTimeoutMs: 20_000,
});

const run = Date.now().toString(36);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const DAY = 24 * 60;

const reasons = {
  new_device: "The request comes from a device the user has not used before",
  unusual_location: "The request comes from a country or a network the user has not been seen in",
  credentials_changed: "The password, the email address or the phone number was changed shortly before the request",
  new_payee: "The money goes to a payee that was added shortly before the request",
  rushed_session: "The session moves from sign-in to moving money much faster than this user's usual visits",
  second_device_in_session: "A device or a network appears in the session that is not the one the session started on",
  unusual_amount: "The amount is far above what this user usually sends",
  pass_through: "Money came in from other people shortly before and is being sent out again",
  remote_access_or_call: "A remote access tool or a long phone call was active during the session",
};
const actions: Record<string, ActionDefinition> = {
  demo_signin: {
    displayName: "Sign-in",
    subject: "user",
    hold: "Should this sign-in be challenged or stopped because it does not look like the owner of the account?",
    reasons: { new_device: reasons.new_device, unusual_location: reasons.unusual_location },
    trigger: "signin_attempted",
  },
  demo_profile_change: {
    displayName: "Profile change",
    subject: "user",
    hold: "Should this change to the account's password, email address or phone number be held because the account shows signs of having been taken over?",
    reasons: {
      new_device: reasons.new_device,
      unusual_location: reasons.unusual_location,
      rushed_session: reasons.rushed_session,
      second_device_in_session: reasons.second_device_in_session,
    },
    trigger: "profile_change_requested",
  },
  demo_new_payee: {
    displayName: "New payee",
    subject: "user",
    hold: "Should adding this payee be held because the account shows signs of fraud, of a takeover, or of its owner being deceived?",
    reasons: {
      new_device: reasons.new_device,
      credentials_changed: reasons.credentials_changed,
      rushed_session: reasons.rushed_session,
      second_device_in_session: reasons.second_device_in_session,
      remote_access_or_call: reasons.remote_access_or_call,
    },
    trigger: "payee_add_requested",
  },
  demo_transfer: {
    displayName: "Transfer",
    subject: "user",
    hold: "Should this transfer be held because the account shows signs of fraud, of a takeover, of its owner being deceived, or of being used to pass on other people's money?",
    reasons,
    typologies: {
      legit: "An ordinary payment by the owner of the account",
      account_takeover: "Someone who is not the owner is using the account",
      scam: "The owner is sending the money, but was deceived into it",
      mule: "The account receives money from other people and passes it on",
    },
    trigger: "transfer_requested",
    context: { totals: [{ name: "money_out", event: "transfer_requested", sum: "usd", window: "session" }] },
  },
};
for (const [name, definition] of Object.entries(actions)) {
  const action = await kairos.defineAction(name, definition);
  console.log(`action ${action.name}@${action.version}`);
}

/** Twelve weeks of ordinary visits: a sign-in on the user's own phone, a look around, sometimes rent. */
function history(user: string, device: string, country: string, payee: string, rent: number) {
  for (let week = 12; week >= 1; week--) {
    const t = week * 7 * DAY + 180;
    const $session = `sess_${run}_${user.split("_")[1]}_w${week}`;
    kairos.track("signin_attempted", {
      userId: user,
      deviceId: device,
      ipCountry: country,
      $session,
      timestamp: ago(t),
    });
    kairos.track("view_balance", { userId: user, $session, timestamp: ago(t - 2) });
    if (week % 4 === 0)
      kairos.track("transfer_requested", { userId: user, payeeId: payee, usd: rent, $session, timestamp: ago(t - 6) });
    if (week % 3 === 0)
      kairos.track("card_payment", {
        userId: user,
        usd: 20 + week * 3,
        merchantCategory: "groceries",
        $session,
        timestamp: ago(t - 9),
      });
  }
}

type Ask = [minutesAgo: number, event: string, properties: EventProperties];
type Note = [minutesAgo: number, event: string, properties: EventProperties, note: true];
interface Visit {
  title: string;
  user: string;
  session: string;
  setup: () => void;
  /** In order. A step with `true` at the end is only recorded; the others ask for a decision. */
  steps: (Ask | Note)[];
}

const u = (name: string) => `user_${name}_${run}`;
const visits: Visit[] = [
  {
    title: "An ordinary evening: rent, then a new payee and a small first payment",
    user: u("amara"),
    session: `sess_${run}_amara`,
    setup: () => history(u("amara"), `dev_amara_${run}`, "GB", `payee_landlord_${run}`, 950),
    steps: [
      [410, "signin_attempted", { deviceId: `dev_amara_${run}`, ipCountry: "GB" }],
      [408, "view_balance", {}, true],
      [404, "transfer_requested", { payeeId: `payee_landlord_${run}`, usd: 950, deviceId: `dev_amara_${run}` }],
      [
        396,
        "payee_add_requested",
        { payeeId: `payee_plumber_${run}`, payeeName: "R. Okafor Plumbing", deviceId: `dev_amara_${run}` },
      ],
      [391, "transfer_requested", { payeeId: `payee_plumber_${run}`, usd: 120, deviceId: `dev_amara_${run}` }],
    ],
  },
  {
    title: "Taken over from the start: a new device abroad, then everything at once",
    user: u("bilal"),
    session: `sess_${run}_bilal`,
    setup: () => history(u("bilal"), `dev_bilal_${run}`, "GB", `payee_landlord_b_${run}`, 1200),
    steps: [
      [330, "signin_attempted", { deviceId: `dev_unknown_b_${run}`, ipCountry: "RO", ipNetwork: "hosting" }],
      [329.5, "profile_change_requested", { field: "password", deviceId: `dev_unknown_b_${run}`, ipCountry: "RO" }],
      [329, "profile_change_requested", { field: "email", deviceId: `dev_unknown_b_${run}`, ipCountry: "RO" }],
      [
        328,
        "payee_add_requested",
        { payeeId: `payee_new_b_${run}`, payeeName: "J. Smith", deviceId: `dev_unknown_b_${run}` },
      ],
      [327.5, "transfer_requested", { payeeId: `payee_new_b_${run}`, usd: 4800, deviceId: `dev_unknown_b_${run}` }],
    ],
  },
  {
    title: "A good session that is stolen half way: a second device appears in it",
    user: u("chen"),
    session: `sess_${run}_chen`,
    setup: () => history(u("chen"), `dev_chen_${run}`, "GB", `payee_landlord_c_${run}`, 800),
    steps: [
      [250, "signin_attempted", { deviceId: `dev_chen_${run}`, ipCountry: "GB" }],
      [247, "transfer_requested", { payeeId: `payee_landlord_c_${run}`, usd: 800, deviceId: `dev_chen_${run}` }],
      [244, "card_payment", { usd: 34, merchantCategory: "groceries" }, true],
      // The same session id, now from another device and another country.
      [221, "view_balance", { deviceId: `dev_other_c_${run}`, ipCountry: "NL", ipNetwork: "vpn" }, true],
      [220, "profile_change_requested", { field: "phone", deviceId: `dev_other_c_${run}`, ipCountry: "NL" }],
      [
        219,
        "payee_add_requested",
        {
          payeeId: `payee_new_c_${run}`,
          payeeName: "Crypto Desk Ltd",
          deviceId: `dev_other_c_${run}`,
          ipCountry: "NL",
        },
      ],
      [
        218,
        "transfer_requested",
        { payeeId: `payee_new_c_${run}`, usd: 3900, deviceId: `dev_other_c_${run}`, ipCountry: "NL" },
      ],
    ],
  },
  {
    title: "Talked into it: her own phone, a long call, a 'safe account', then a second payment",
    user: u("dora"),
    session: `sess_${run}_dora`,
    setup: () => history(u("dora"), `dev_dora_${run}`, "GB", `payee_landlord_d_${run}`, 700),
    steps: [
      [160, "signin_attempted", { deviceId: `dev_dora_${run}`, ipCountry: "GB" }],
      [158, "call_started", { direction: "incoming", number: "withheld" }, true],
      [146, "remote_access_app_opened", { app: "AnyDesk" }, true],
      [
        141,
        "payee_add_requested",
        {
          payeeId: `payee_safe_${run}`,
          payeeName: "Safe Account 4471",
          deviceId: `dev_dora_${run}`,
          callActiveMinutes: 17,
          remoteAccessActive: true,
        },
      ],
      [
        139,
        "transfer_requested",
        {
          payeeId: `payee_safe_${run}`,
          usd: 2500,
          deviceId: `dev_dora_${run}`,
          callActiveMinutes: 19,
          remoteAccessActive: true,
        },
      ],
      [
        133,
        "transfer_requested",
        {
          payeeId: `payee_safe_${run}`,
          usd: 6400,
          deviceId: `dev_dora_${run}`,
          callActiveMinutes: 25,
          remoteAccessActive: true,
        },
      ],
    ],
  },
  {
    title: "On holiday: her own phone in another country, and small payments",
    user: u("efua"),
    session: `sess_${run}_efua`,
    setup: () => history(u("efua"), `dev_efua_${run}`, "GB", `payee_landlord_e_${run}`, 1000),
    steps: [
      [95, "signin_attempted", { deviceId: `dev_efua_${run}`, ipCountry: "PT", ipNetwork: "mobile" }],
      [93, "card_payment", { usd: 18, merchantCategory: "restaurants", country: "PT" }, true],
      [
        90,
        "transfer_requested",
        { payeeId: `payee_landlord_e_${run}`, usd: 1000, deviceId: `dev_efua_${run}`, ipCountry: "PT" },
      ],
      [
        84,
        "payee_add_requested",
        { payeeId: `payee_friend_${run}`, payeeName: "M. Santos", deviceId: `dev_efua_${run}`, ipCountry: "PT" },
      ],
      [
        82,
        "transfer_requested",
        { payeeId: `payee_friend_${run}`, usd: 45, deviceId: `dev_efua_${run}`, ipCountry: "PT" },
      ],
    ],
  },
  {
    title: "A three-day-old account: money arrives from strangers and goes straight out",
    user: u("finn"),
    session: `sess_${run}_finn`,
    setup: () => {
      kairos.track("account_opened", {
        userId: u("finn"),
        deviceId: `dev_finn_${run}`,
        ipCountry: "GB",
        timestamp: ago(3 * DAY),
      });
      kairos.track("signin_attempted", {
        userId: u("finn"),
        deviceId: `dev_finn_${run}`,
        ipCountry: "GB",
        $session: `sess_${run}_finn_first`,
        timestamp: ago(3 * DAY - 5),
      });
    },
    steps: [
      [44, "signin_attempted", { deviceId: `dev_finn_${run}`, ipCountry: "GB" }],
      [
        42,
        "payee_add_requested",
        { payeeId: `payee_out_1_${run}`, payeeName: "K. Novak", deviceId: `dev_finn_${run}` },
      ],
      [40, "transfer_requested", { payeeId: `payee_out_1_${run}`, usd: 25, deviceId: `dev_finn_${run}` }],
      [31, "deposit_received", { usd: 2900, senderId: `sender_1_${run}` }, true],
      [28, "deposit_received", { usd: 3100, senderId: `sender_2_${run}` }, true],
      [26, "transfer_requested", { payeeId: `payee_out_1_${run}`, usd: 2850, deviceId: `dev_finn_${run}` }],
      [22, "deposit_received", { usd: 4700, senderId: `sender_3_${run}` }, true],
      [
        20,
        "payee_add_requested",
        { payeeId: `payee_out_2_${run}`, payeeName: "Exchange Hub", deviceId: `dev_finn_${run}` },
      ],
      [19, "transfer_requested", { payeeId: `payee_out_2_${run}`, usd: 7700, deviceId: `dev_finn_${run}` }],
    ],
  },
];

for (const visit of visits) {
  visit.setup();
  console.log(`\n${visit.title}\n  ${visit.user}   session ${visit.session}`);
  const first = visit.steps[0]![0];
  for (const [minutesAgo, event, properties, note] of visit.steps) {
    const sent = { userId: visit.user, ...properties, $session: visit.session, timestamp: ago(minutesAgo) };
    const clock =
      `+${Math.floor(first - minutesAgo)}:${String(Math.round(((first - minutesAgo) % 1) * 60)).padStart(2, "0")}`.padEnd(
        7,
      );
    if (note) {
      kairos.track(event, sent);
      console.log(`  ${clock} ${event}`);
      continue;
    }
    // The request is the event: it is stored, and the action it starts decides.
    const decision = await kairos.trackAndDecide(event, sent);
    console.log(
      `  ${clock} ${event.padEnd(26)} → ${decision.decision.padEnd(8)} risk ${String(decision.riskScore).padStart(3)}  ${decision.typology ? `${decision.typology}  ` : ""}${decision.reasons.join(", ")}`,
    );
  }
}
console.log(`\nIn the console: #/sessions lists them. Open one and play it.`);

await kairos.shutdown();

function missingKey(): never {
  console.error(
    "KAIROS_API_KEY is not set. Put a secret key (ksk_…) in .env at the root of the repository. Make one in the console: Settings › API keys.",
  );
  process.exit(1);
}
