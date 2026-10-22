# 31 Harbor - brand and email style guide

**Domain:** `31harbor.com`  
**From address:** `31 Harbor <hello@31harbor.com>`  
**Also called:** 31 Harbor, Cuttlefish Labs, Cuttlefish  
**Weekly subject line:** 31 Harbor Weekly

## What this brand is

Agent identity, trust scores, contracts and the fleet that holds them.

The weekly opens with: *"A week of the trust ledger, the agents on it, and what changed."*

## How it looks

The colours below are the brand's own, read out of its site. They are
not chosen for an email - the email uses the brand.

This brand is **dark-first**: the dark palette is inline on every element, and the
light palette takes over in a client that prefers a light scheme.

| Role | Colour |
|---|---|
| bg | `#0d1f2c` |
| bgDeep | `#07141d` |
| panel | `#153044` |
| panelAlt | `#102838` |
| border | `#2c5470` |
| text | `#eef3f7` |
| muted | `#a8bccd` |
| faint | `#7d95a8` |
| accent | `#c9a962` |
| violet | `#8fb8d4` |
| ok | `#4caf50` |
| warn | `#e0b64c` |
| crit | `#e57373` |
| codeBg | `#091a26` |

The other scheme uses: background `#e8edf1`, panel `#ffffff`, text `#0d1f2c`, accent `#8a6d21`.

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

**Measured and institutional. This brand talks about identity and proof.**

Always:

- Lead with the ledger: what was recorded, by whom, when.
- Name an agent by its DID when the agent has one.
- Report a trust score as a score and a timestamp, never as a verdict.

Never:

- Do not describe an agent as trustworthy or untrustworthy - report the score.
- Do not count a credential as a credential until it is in cac_credentials.
- Do not summarise a fabrication event away.

## The weekly

The 31 Harbor weekly carries these sections, in this order:

- trust
- agents
- contracts
- commits
- work

Each section names its own source. A source that could not be reached
becomes a visible line in the email - never a silent omission, and never a
number that was not fetched.

"What shipped" reads the commits of `xmrtdao/31harborsoftware`.

## The rules that do not change

- The From address decides the brand. Naming another brand does not move it.
- A figure that was not fetched is never printed.
- A gap is recorded as a gap. Nothing is filled in from memory.
- Every send carries both the rich HTML and the plain text.
- The email states what could not be fetched, in the email itself.
