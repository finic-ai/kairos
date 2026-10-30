<!-- Generated from templates/events/ by pnpm docs:events. Edit those files, not this page. -->

# Event templates

Recommended shapes for common events, one page each. Kairos accepts any event, so none of these is required. [About templates](../overview.md#event-shapes)

| Event | Type | What it is | |
|---|---|---|---|
| [Account Opened](account_opened.md) | `account_opened` | A new account was opened. |  |
| [Application Submitted](application_submitted.md) | `application_submitted` | An application was completed: for an account, a loan, a merchant account. |  |
| [Bank Transfer Requested](bank_transfer_requested.md) | `bank_transfer_requested` | A request that needs a decision. | starts a decision |
| [Beneficiary Added](beneficiary_added.md) | `beneficiary_added` | A payee, a beneficiary or a withdrawal address was added. |  |
| [Contact Changed](contact_changed.md) | `contact_changed` | A phone number or an email address on the account was changed. |  |
| [Fraud Claim](fraud_claim.md) | `fraud_claim` | A customer says a transaction was not theirs. | record with stages |
| [Login](login.md) | `login` | A user signed in. |  |
| [Login Failed](login_failed.md) | `login_failed` | A sign-in attempt that did not succeed. |  |
| [Password Reset](password_reset.md) | `password_reset` | A password was reset. |  |
| [Support Message](support_message.md) | `support_message` | Something the customer wrote. |  |
| [Transaction](transaction.md) | `transaction` | Money moved, or is about to. | record with stages |
