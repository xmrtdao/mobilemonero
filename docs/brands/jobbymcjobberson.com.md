# Jobby McJobberson - brand and email style guide

**Domain:** `jobbymcjobberson.com`  
**From address:** `Jobby McJobberson <hello@jobbymcjobberson.com>`  
**Also called:** Jobby McJobberson, Jobby  
**Weekly subject line:** Jobby Weekly

## What this brand is

The applications, the resumes and the mailboxes that make them possible.

The weekly opens with: *"A week of applications, the blockers in the way, and what got sent."*

## How it looks

The colours below are the brand's own, read out of its site. They are
not chosen for an email - the email uses the brand.

This brand is **light-first**: the light palette is inline on every element, and the
dark palette takes over in a client that prefers a dark scheme.

| Role | Colour |
|---|---|
| bg | `#f1f5f9` |
| bgDeep | `#e2e8f0` |
| panel | `#ffffff` |
| panelAlt | `#f8fafc` |
| border | `#cbd5e1` |
| text | `#0f172a` |
| muted | `#475569` |
| faint | `#94a3b8` |
| accent | `#2563eb` |
| violet | `#7c3aed` |
| ok | `#166534` |
| warn | `#854d0e` |
| crit | `#b91c1c` |
| codeBg | `#f1f5f9` |

The other scheme uses: background `#0a1120`, panel `#1e293b`, text `#f1f5f9`, accent `#60a5fa`.

## The shape of an email

Every email from this brand has the same shell, and every tenant's is
the same shell - so a reader who gets one brand's mail knows what to
expect from the others.

- A dark gradient masthead with the brand name, the agent, and its role.
- The subject as the heading.
- The body, as markdown rendered to styled HTML.
- A quote block when something the agent wrote is being quoted back.
- A footer that says where every number came from, and what could not be fetched.

Charts are inline SVG, drawn from live data. A `chart` block takes JSON:

```chart
{"type":"area","title":"Monero since Jan 10, 2025","data":[{"at":1736467200000,"value":199.62}],"startLabel":"$199.62","endLabel":"$624.05","startDate":"Jan 10, 2025","endDate":"Oct 21, 2026","reference":{"value":199.62,"label":"where we started"}}
```

The chart types are `area`, `callout`, `donut`, `ring`, `bar` and `spark`.
A `stats` block takes rows:

```stats
{"title":"The market","data":[{"label":"Market cap","value":"$11.75B"}]}
```

Every email also carries a plain-text version of the same content. Half
the people reading an email are reading it in a client that shows nothing but
text, and the text version is the content, not a summary of it.

## How it writes

**Plain and private. This is a person's own address; it reads like a note to them.**

Always:

- Address the candidate directly. It is their mailbox.
- Name a blocker specifically - "no verified mailbox" beats "blocked".
- Report what was actually sent, and to whom.

Never:

- Do not put one candidate's application list in front of another.
- Do not claim an application was submitted without a submitted_at.
- Do not guess at a company's hiring process.

## The weekly

The Jobby McJobberson weekly carries these sections, in this order:

- candidates
- applications
- work

Each section names its own source. A source that could not be reached
becomes a visible line in the email - never a silent omission, and never a
number that was not fetched.

"What shipped" reads the commits of `xmrtdao/jobbymcjobberson`.

## The rules that do not change

- The From address decides the brand. Naming another brand does not move it.
- A figure that was not fetched is never printed.
- A gap is recorded as a gap. Nothing is filled in from memory.
- Every send carries both the rich HTML and the plain text.
- The email states what could not be fetched, in the email itself.
