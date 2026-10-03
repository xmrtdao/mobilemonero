# Jobby McJobberson

Jobby McJobberson is a multi-track opportunity and outreach engine for Joseph Andrew Lee's job search. It keeps recipient preparation, campaign delivery, and ATS automation separate so each boundary can be tested and audited.

## Track status

| Track | Purpose | Current status |
| --- | --- | --- |
| Track 1 | Contract consultancy and high-engagement personalized outreach | Active recipient pipeline: normalization, deduplication, suppression, and malformed-record auditing |
| Track 2 | Temporary and contract opportunities | Planned |
| Track 3 | Full-time employment opportunities | Planned |
| Track 4 | ATS application automation | Planned; use the canonical page-agent boundary |

The current repository does **not** contain a scraper, scheduler, sender, or ATS implementation. Track 1 currently prepares verified recipient records only; it does not send messages.

## Track 1 recipient pipeline

`lead_utils.py` provides the pure Python pipeline used by the tests:

- normalize recipient fields and email addresses without mutating the input;
- preserve missing and explicitly unverified contacts as unknown;
- create stable identity keys for verified emails or missing-email records;
- deduplicate recipients first-wins while preserving order;
- apply identity, verified-email, and explicit consent-denial suppression;
- discard malformed records with audit data.

Jobby must never invent an email address, phone number, or other contact detail. Unknown contacts stay unknown.

## Scope boundary

The original lead-scraper code was built for Party Favor Photo (PFP) event-related leads. Its PFP-specific sources, fields, estimates, and outreach assumptions are legacy and are not part of Jobby. The unrelated PFP scraper, outreach, manual-collection, template, and resume files have been removed from this repository.

Do not add a parallel scheduler, sender, scraper, database, or ATS service. Future integrations must adapt to the canonical fleet services:

- `campaign-scheduler` and Resend handle campaign cadence and delivery;
- `page-agent` handles ATS form filling and resume upload;
- Jobby remains the opportunity/recipient adapter and preparation layer.

Costa Rica targeting and Spanish-language messaging are additive variants. They must not change the canonical identity, suppression, or no-fabrication rules.

## Canonical outbound inputs

The outbound email structure and resume live in shared context, not in this repository:

- `hiring_manager_email_template_v1`
- `resume_joseph_lee`
- `contact_joseph_andrew_lee`

Outbound hiring-manager messages use this order: a short positioning pitch, the canonical chronological resume, then Joseph's LinkedIn and phone contact block. Messages are sent as Joseph Andrew Lee, never as a fleet-agent persona. Do not commit the resume or email bodies to this repository.

## Development and verification

The project uses Python 3.13 in CI and has no third-party runtime dependency for the current recipient pipeline.

From the repository root:

```bash
python -m unittest discover -s tests -v
python -m compileall -q lead_utils.py tests
git diff --check
```

On the Windows fleet workspace, the equivalent test command is:

```powershell
py -m unittest discover -s tests -v
```

## Repository layout

- `lead_utils.py` - recipient normalization, identity, deduplication, and suppression helpers
- `tests/` - standard-library unit tests for the recipient pipeline
- `.github/workflows/ci.yml` - compile, test, and diff-cleanliness gate
- `requirements.txt` - intentionally empty because the current pipeline uses only the Python standard library
