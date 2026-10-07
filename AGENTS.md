# AGENTS.md — how to work in this repo

Standing instructions for any agent working here. Written after a session in
which the most important bug was found by using the product as a user rather
than by reading the code.

---

## Protocol: surface real user-experience blockers

**A feature that cannot be reached by a user is broken, however well it is
built, and no amount of reading the code will tell you.**

### What prompted this

Three defects, in one afternoon, all in the email-verification flow. Every one of
them passed inspection:

| What the code said | What a user got |
|---|---|
| `POST /api/jobby/claim` returns 200, "a code is on its way" | The code arrived and the relay **discarded it** — `REJECTED jobbymcjobberson.com: signature-mismatch` |
| Comment: *"Sent from the candidate's own jobby mailbox, so the code arrives somewhere only they can read"* | `resolveJobbySender()` called with no argument → fell through to the hardcoded `jobby@31harbor.com` fallback. A **system** address, on a different domain |
| Two endpoints, fully implemented, fully tested | **No front-end file calls them.** `jobby.js` wires session, history, dossier, chat, client, outreach — not `claim` |

The net effect: the verification feature was **dead for every real user**, and
no amount of reading `server.js` would have shown it. A candidate would click
"send me a code", be told it was on its way, and wait forever. The apply gate
that depends on it could never be satisfied, so `jobby_apply` was permanently
blocked — and the tests all passed, because every test exercised the endpoint
rather than the journey.

### The rule

**Before reporting a feature as working, walk it as a user, end to end, through
the real UI and the real endpoints.** Not the unit test. Not the function. The
journey a person takes, in order, with the things they can actually see.

Concretely, for any flow:

1. **Start where the user starts.** The public page, not the internal route.
2. **Do the steps in order**, as a person would, using the real forms.
3. **Read what the user reads** — the toast, the banner, the error. Not the
   server log, though you will read that too.
4. **Follow the data to its real destination.** A 200 means the request was
   accepted. It does not mean the message arrived, the file was written, or the
   row was created.
5. **Check the thing on the other end exists.** If the product says "we emailed
   you", find the email. If it says "saved", find the row.

### What to report

When a flow is blocked, say so in these terms — and say it even if the parts all
work:

- **What the user sees** — the exact message, and which step it happens at.
- **What actually happened** — the log line, the rejected webhook, the null row.
- **The gap between them** — this is the bug, stated in one sentence.
- **Who it blocks** — an unclaimed address means the apply gate never opens, so
  the honest headline is "nobody can use this", not "this endpoint is
  unreachable".

Do not soften a blocker into a footnote. "Minor: the claim UI is missing" buries
the fact that the feature is unusable end to end.

### Standing checks before calling anything done

- **Is there a UI for it?** Grep the front-end for the endpoint. An endpoint no
  page calls is not a feature.
- **Did it actually arrive?** If the product claims to have sent or saved
  something, go and find it. Absence of a complaint is not evidence of success.
- **Does the user have to guess?** Any instruction that lives only in a comment,
  a README or an agent's head is an instruction the user does not have.
- **Would a stranger get through?** Test from a clean browser with no cookies.
  A flow that only works because your session is already warm is not a flow.

---

## Other standing rules in this repo

### Never print a credential

Report shape and length only. `SET, 36 chars`. Never the value, never a prefix
that would narrow a brute force.

### Never invent a dossier fact

A gap is recorded as a gap. A role with an unstated title keeps an unstated
title. "Never invent" includes *you* filling in something the candidate implied
but did not say — an inferred employer, a guessed year, a "current" that was
never confirmed.

### A merge may not invent a tenure

Two documents describing one job with different dates is a **conflict to
surface**, not a range to union. `role-match.mjs` reports every disagreeing
field and `dossier-merge.mjs` protects all of them; both halves are load-bearing
and each has been the bug once.

### A verification mark is a claim about the check, not the person

Only `verified` earns a mark, and only from a source the candidate **cannot
edit**. Their site, their LinkedIn, their repository, a wiki page they wrote:
agreement there is one claim counted twice. Counting is never a route to a mark.
Enforced in `verification.mjs` *and* as CHECK constraints — a comment is not a
constraint.

### The gate is the product

`assertCanRepresent` is why a mistyped address cannot send anything. Never set
`claimed_email` by hand to get past it, and never weaken it to make a test
pass. If a test needs a verified client, verify one for real.
