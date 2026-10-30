# How links are reported

This page shows exactly what a decision is told about a link. For the idea, see [Link](core-concepts.md#link) in the concepts.

Two subjects are linked when events of each of them name the same third entity: a device, a bank account, an ATM. Sharing alone proves little, because honest customers and fraudsters use the same shops and the same cash machines. So for each linked entity the model is given facts about concentration, not a verdict:

```json
"atm atm_central_14": {
  "first_seen": "2026-08-09T10:12:00",
  "other_users": 91,
  "other_users_by_label": { "mule_confirmed": { "users": 4, "share": 0.044, "normal_share": 0.011 } },
  "last_30_days": {
    "other_users": 91,
    "of_them_new_accounts": 11,
    "in_last_24_hours": { "other_users": 9, "of_them_new_accounts": 7 },
    "in_last_30_minutes": { "other_users": 6, "of_them_new_accounts": 5 },
    "by_label": { "mule_confirmed": { "users": 4, "share": 0.044, "normal_share": 0.011 } }
  }
}
```

- **Share against the normal share.** How many of the linked subjects carry a label, and how common that label is among all subjects. A busy supermarket has the normal share; a mule ATM does not.
- **A recent window.** The last 30 days, the last 24 hours and the last 30 minutes before the decision. Concentration in time is what makes a shared place a link.
- **New accounts.** How many of the recent subjects were themselves first seen in the window. A burst of new accounts at one place is a signal that needs no label.

`linkTypes` is still useful when an entity type should never be a link for an action, or to save the lookups.

**Where to put a label.** Label the thing the outcome is about. A claim closed as account abuse is about the customer, so label the customer. A confirmed card fraud at a merchant is about the merchant, so label the merchant, not the victim.

Next: [Workspaces](../platform/workspaces.md).
