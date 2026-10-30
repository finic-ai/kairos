# The evaluation suite

Every change to the context builder, the questions or the policy should be run through `pnpm eval`. It reports, per case type, how many withdrawals were held or stepped up, and overall:

- **catch rate**: positives that were not approved
- **false-action rate**: negatives that were not approved

It exits non-zero if the catch rate falls or the false-action rate rises against `packages/eval/accepted.json`.

Model responses are cached in `packages/eval/cache` by request hash. In a new clone, run `pnpm eval:generate` to write `cases/v1.jsonl` (the generator is seeded, so it writes the same cases each time), and set `GRAYSON_API_KEY` for the first run, which fills the cache. A run that changes nothing reads the cache, makes no API calls and needs no key. A change to the context or the questions produces new requests; set `GRAYSON_API_KEY` for those (about $0.01 for a full run).

### Accepted baseline (`cases/v1.jsonl`, the `withdrawal` template)

| Case type | Label | Held | Step-up | Not approved |
|---|---|---|---|---|
| normal_easy | negative | 0 | 0 | 0 of 10 |
| normal_hard | negative | 0 | 0 | 0 of 10 |
| normal_pass_through | negative | 0 | 5 | 5 of 10 |
| normal_new_account | negative | 0 | 6 | 6 of 10 |
| ato_easy | positive | 10 | 0 | 10 of 10 |
| ato_hard | positive | 6 | 0 | 6 of 10 |
| scam_easy | positive | 10 | 0 | 10 of 10 |
| scam_hard | positive | 8 | 2 | 10 of 10 |
| ring_one_hop | positive | 10 | 0 | 10 of 10 |
| ring_two_hop | positive | 0 | 10 | 10 of 10 |

Catch rate 0.933, false-action rate 0.275, AUC of the hold probability 0.990.

This baseline includes the template's total: money in for 7 days, against a usual week, and the share of the withdrawal it covers. Before the total, the catch rate was 0.867 and the false-action rate 0.25. The gain is the two-hop rings: all ten are now stepped up by the pass-through rule, against five. The cost is one more honest new account stepped up.

Known gaps this baseline makes visible:

- The pass-through rule steps up honest customers who buy and move coins to a new wallet of their own (5 of 5 first-time self-custody cases, 6 of 10 new accounts). No honest customer was held; all eleven were step-ups.
- Rings whose risky accounts are two steps away are caught only by the rule, as a step-up, because the link summary is one hop. None is held by the score.
- Four hard takeovers score below the 0.5 review threshold.
- **A difference of one case between two runs is not a result.** Grayson does not always return the same probability for the same request: when the 100 requests of this baseline were sent a second time, 25 answers differed, by up to 0.06, and one case crossed the review threshold. The cache makes a run repeatable; it does not make the model repeatable.

All cases are synthetic and written by the same people who wrote the policy. The suite measures change, not real-world accuracy.
