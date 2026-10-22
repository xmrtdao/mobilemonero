# Party Favor Photo - brand and email style guide

**Domain:** `partyfavorphoto.com`  
**From address:** `Party Favor Photo <hello@partyfavorphoto.com>`  
**Also called:** Party Favor Photo, PFP, Photographic & Communication Services  
**Weekly subject line:** Party Favor Photo Weekly

## What this brand is

Bookings, the leads behind them, and the shoots on the calendar.

The weekly opens with: *"A week of bookings, the leads behind them, and the shoots on the calendar."*

## How it looks

The colours below are the brand's own, read out of its site. They are
not chosen for an email - the email uses the brand.

This brand is **dark-first**: the dark palette is inline on every element, and the
light palette takes over in a client that prefers a light scheme.

| Role | Colour |
|---|---|
| bg | `#0d0d15` |
| bgDeep | `#07070c` |
| panel | `#171724` |
| panelAlt | `#12121d` |
| border | `#2c2c3f` |
| text | `#f2f2f7` |
| muted | `#a9a9bf` |
| faint | `#7c7c93` |
| accent | `#d12e2e` |
| violet | `#8b5cf6` |
| ok | `#4caf50` |
| warn | `#fbbf24` |
| crit | `#ef4444` |
| codeBg | `#0a0a11` |

The other scheme uses: background `#eceef2`, panel `#ffffff`, text `#0d0d15`, accent `#b91c1c`.

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

**Warm and practical. A photographer writes to a client, not to a board.**

Always:

- Say what was booked, for when, and where.
- Name a client the way they would want to be named.
- Keep it short - this audience is a client, not an investor.

Never:

- Do not expose another client's details in a shared list.
- Do not state a booking is confirmed without its status saying confirmed.
- Do not report a lead as won before the contract is signed.

## The weekly

The Party Favor Photo weekly carries these sections, in this order:

- bookings
- leads
- work

Each section names its own source. A source that could not be reached
becomes a visible line in the email - never a silent omission, and never a
number that was not fetched.

"What shipped" reads the commits of `xmrtdao/partyfavorphoto`.

## The rules that do not change

- The From address decides the brand. Naming another brand does not move it.
- A figure that was not fetched is never printed.
- A gap is recorded as a gap. Nothing is filled in from memory.
- Every send carries both the rich HTML and the plain text.
- The email states what could not be fetched, in the email itself.
