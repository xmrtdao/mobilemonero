# MobileMonero - brand and email style guide

**Domain:** `mobilemonero.com`  
**From address:** `MobileMonero <hello@mobilemonero.com>`  
**Also called:** MobileMonero, XMRT-DAO, XMRT DAO, Monero  
**Weekly subject line:** MobileMonero Weekly

## What this brand is

Monero mining on a phone, the fleet that runs it, and what we published.

The weekly opens with: *"A week of what the fleet is worth, what it shipped, and what it published."*

## How it looks

The colours below are the brand's own, read out of its site. They are
not chosen for an email - the email uses the brand.

This brand is **dark-first**: the dark palette is inline on every element, and the
light palette takes over in a client that prefers a light scheme.

| Role | Colour |
|---|---|
| bg | `#0a0e1a` |
| bgDeep | `#060911` |
| panel | `#141a2b` |
| panelAlt | `#101524` |
| border | `#2b3348` |
| text | `#f5f1e8` |
| muted | `#b3ab97` |
| faint | `#8b7355` |
| accent | `#ff6600` |
| violet | `#d4af37` |
| ok | `#4caf50` |
| warn | `#ffd700` |
| crit | `#ef5350` |
| codeBg | `#0b0f1c` |

The other scheme uses: background `#eae3d4`, panel `#fffdf7`, text `#1b1710`, accent `#c2410c`.

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

**Plain, exact, warm. Numbers carry the argument; the prose stays short.**

Always:

- Quote the figure and where it came from.
- Say plainly when a source could not be reached.
- Use the word Monero, not XMR, in prose - XMR is for the tables.

Never:

- Do not promise earnings, returns or yields of any kind.
- Do not say a price is up or down without the window it moved over.
- Do not call the pool the fleet's own hashrate - they are different numbers.

## The weekly

The MobileMonero weekly carries these sections, in this order:

- price
- pool
- articles
- commits
- work

Each section names its own source. A source that could not be reached
becomes a visible line in the email - never a silent omission, and never a
number that was not fetched.

"What shipped" reads the commits of `xmrtdao/mobilemonero`.

## The rules that do not change

- The From address decides the brand. Naming another brand does not move it.
- A figure that was not fetched is never printed.
- A gap is recorded as a gap. Nothing is filled in from memory.
- Every send carries both the rich HTML and the plain text.
- The email states what could not be fetched, in the email itself.
