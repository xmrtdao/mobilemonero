/**
 * relay/jobby/titles-trades.mjs — trades, industrial and site professions
 *
 * Added after the first pass, because a FIFO candidate's own resume matched
 * nothing and Jobby said so: *"It returned no matches. That's a gap in the
 * library, not a judgment on your background."*
 *
 * That was the library working correctly — an honest negative rather than a
 * confident guess. But the gap was real, and it was the largest one, because
 * FIFO is a whole track aimed at exactly these people.
 *
 * ── Why this is a separate file and not more entries in titles.mjs ─────────
 *
 * The vocabulary is different in kind. Tech titles cluster on tooling
 * (`airflow`, `dbt`, `rag`); trades cluster on **tasks, tickets and
 * jurisdictions**. A welder's resume says "6G, FCAW, ASME IX" — a Canadian
 * qualification and a wire process — not "welding" in the abstract. Matching
 * trades on generic skill words produces noise, so `tickets` below is a
 * first-class field: the licence or ticket a trade actually gates on, which is
 * what decides whether a candidate can legally take the job.
 *
 * ── What `ticketMeans` is for ──────────────────────────────────────────────
 *
 * A Red Seal is not a nice-to-have; in most Canadian provinces you cannot be
 * hired as a journeyperson without one. Telling a candidate their background
 * "looks like a fit" while omitting that is the worst kind of wrong: they
 * interview, they find out, and they blame the agent. So a match without the
 * ticket says so in words.
 */

/** Jurisdictional ticket systems, and what each one gates. */
export const TICKET_SYSTEMS = {
  red_seal: {
    key: 'red_seal',
    label: 'Red Seal',
    where: 'Canada',
    gates: 'Provincial journeyperson trades. Most employers will not hire without it.',
  },
  journeyman: {
    key: 'journeyman',
    label: 'Journeyman',
    where: 'United States and many jurisdictions',
    gates: 'State licensing for electrical, plumbing and most construction trades.',
  },
  apprenticeship: {
    key: 'apprenticeship',
    label: 'Apprenticeship completion',
    where: 'Various',
    gates: 'Apprenticeship completion. Often the entry point where the ticket itself is earned.',
  },
  ticket_au: {
    key: 'ticket_au',
    label: 'Trade qualification (Australia)',
    where: 'Australia',
    gates: 'State qualification for most trades; widely required on FIFO sites.',
  },
  ndt: {
    key: 'ndt',
    label: 'NDT certification',
    where: 'International',
    gates: 'Non-destructive testing levels (ASNT/ISO 9712). Oil and gas and pipeline work.',
  },
  safety: {
    key: 'safety',
    label: 'Safety certification',
    where: 'International',
    gates: 'H2S, SCBA, confined space, working at height, first aid. Site access, often mandatory.',
  },

  // ── Credentials defined in titles-professions.mjs. Declared here because the
  //    ticket vocabulary has to be one registry: a resume saying "CDL Class A" or
  //    "RN, BSN" states a licence exactly as "Red Seal" does, and detectTickets()
  //    is the only thing that reads them all.
  //
  //    `jurisdictionScoped` is the field that earns its keep. 20 of the 35
  //    professions hold a credential that does not cross a state, province or
  //    national border — a teaching certificate, a nursing licence, an agency
  //    certification. A candidate who holds it and is moving is qualified and
  //    employable, but not *here*, and that is worth saying plainly rather than
  //    discovering at the interview.
  fmcsa: {
    key: 'fmcsa',
    label: 'FMCSA CDL',
    where: 'United States',
    jurisdictionScoped: false,
    gates: 'Federal commercial licence for vehicles over 26,000 lb. Medical card required.',
  },
  state_cdl: {
    key: 'state_cdl',
    label: 'Provincial CDL equivalent',
    where: 'Canada',
    jurisdictionScoped: true,
    gates: 'Provincial commercial licence. Not transferable between provinces without re-testing.',
  },
  dangerous_goods: {
    key: 'dangerous_goods',
    label: 'Dangerous goods endorsement',
    where: 'Jurisdiction-dependent',
    jurisdictionScoped: false,
    gates: 'Hazmat endorsement (US) or TDG training (Canada). Required to haul fuel, chemicals or explosives.',
  },
  nursing_license: {
    key: 'nursing_license',
    label: 'State nursing licence',
    where: 'United States',
    jurisdictionScoped: true,
    gates: 'State-issued. The Nurse Licensure Compact covers most states; an internationally educated nurse still faces NCLEX.',
  },
  medical_license: {
    key: 'medical_license',
    label: 'Medical licence',
    where: 'Jurisdiction-dependent',
    jurisdictionScoped: true,
    gates: 'State or provincial licence to practise. Recognition from abroad is a separate process.',
  },
  teaching_certificate: {
    key: 'teaching_certificate',
    label: 'Teaching certificate',
    where: 'State or province',
    jurisdictionScoped: true,
    gates: 'Required to teach. Does not transfer between states or provinces — the single most common reason an experienced teacher cannot teach where they moved.',
  },
  peace_officer: {
    key: 'peace_officer',
    label: 'Peace officer certification',
    where: 'Agency',
    jurisdictionScoped: true,
    gates: 'Agency-specific academy certification. Follows the badge.',
  },
  firefighter_cert: {
    key: 'firefighter_cert',
    label: 'Firefighter certification',
    where: 'State/province and department',
    jurisdictionScoped: true,
    gates: 'IFAC certification plus department-specific training and a fitness standard.',
  },
  correction_officer: {
    key: 'correction_officer',
    label: 'Corrections certification',
    where: 'Agency',
    jurisdictionScoped: true,
    gates: 'Agency-specific certification, usually with a background and fitness standard.',
  },
  aircrew: {
    key: 'aircrew',
    label: 'Aircrew licence',
    where: 'National aviation authority',
    jurisdictionScoped: true,
    gates: 'FAA, Transport Canada or CASA licence with instrument and type ratings.',
  },
  maritime_cert: {
    key: 'maritime_cert',
    label: 'Flag-state certificate',
    where: 'Flag state',
    jurisdictionScoped: true,
    gates: 'Watchkeeping certification tied to a flag state.',
  },
  first_aid_instructor: {
    key: 'first_aid_instructor',
    label: 'Instructor certification',
    where: 'Certifying body',
    jurisdictionScoped: false,
    gates: 'Often the route into teaching the credential rather than practising it.',
  },
  marine: {
    key: 'marine',
    label: 'Marine certificate',
    where: 'International',
    gates: 'Flag-state engine or deck certification. Mandatory to serve aboard.',
  },
};

/**
 * @typedef {object} TradeTitle
 * @property {string} id
 * @property {string} name
 * @property {string} family
 * @property {string} definition
 * @property {string[]} signals
 * @property {string[]} tickets       ticket keys from TICKET_SYSTEMS
 * @property {string} ticketMeans     what the ticket decides, in plain words
 * @property {string[]} supersedes
 * @property {string[]} notEqualTo
 * @property {string[]} nearbyRoles   adjacent titles a candidate is NOT
 * @property {string} notableFor
 * @property {boolean} [remote]       genuinely deliverable off-site
 * @property {boolean} [fifo]         commonly rotational or site-based
 */

export const TRADE_FAMILIES = {
  electrical: 'Electrical',
  mechanical: 'Mechanical and maintenance',
  welding_fab: 'Welding and fabrication',
  construction: 'Construction and carpentry',
  mining: 'Mining and processing',
  oilgas: 'Oil, gas and pipelines',
  marine: 'Marine and shipboard',
  hse: 'Health, safety and environment',
  logistics: 'Logistics and transport',
  heavy_equipment: 'Heavy equipment and driving',
};

const T = 'red_seal';
const J = 'journeyman';
const AP = 'apprenticeship';
const AU = 'ticket_au';
const NDT = 'ndt';
const SAFETY = 'safety';
const MARINE = 'marine';

/** @type {TradeTitle[]} */
export const TRADE_TITLES = [
  // ── Electrical ───────────────────────────────────────────────────────────
  {
    id: 'electrician',
    name: 'Electrician',
    family: 'electrical',
    definition:
      'Installs, tests and repairs electrical distribution and equipment. Industrial and '
      + 'mining electricians work on high-voltage systems, switchgear, motors and plant '
      + 'wiring rather than domestic circuits.',
    signals: [
      'electrician', 'electrical technician', 'electrical engineer', 'master electrician',
      'high voltage', 'hv switching', 'switchgear', 'transformer', 'panel installation',
      'motor control', 'plc', 'troubleshooting', 'conduit', 'lockout', 'tagout', 'loto',
      'arc flash', 'megger testing', 'thermal imaging',
    ],
    tickets: [T, J],
    ticketMeans:
      'A licensed ticket is normally required. Without one you can be hired as an '
      + 'apprentice or helper, but not as an electrician.',
    supersedes: [],
    notEqualTo: ['electrical engineer', 'electronics technician'],
    nearbyRoles: ['instrumentation technician', 'control systems engineer'],
    notableFor: 'The most portable trade in the list — the ticket travels across employers and provinces.',
  },
  {
    id: 'instrumentation_tech',
    name: 'Instrumentation Technician',
    family: 'electrical',
    definition:
      'Measures and controls process variables — pressure, temperature, flow, level — and '
      + 'keeps loops, transmitters, valves and DCS in calibration. The trade that keeps a '
      + 'mine or refinery running, and the single most requested role in the FIFO roster.',
    signals: [
      'instrumentation technician', 'instrument technician', 'instrument mechanic',
      'instrumentation', 'calibration', 'loop checking', 'loop check', 'transmitter',
      'pressure transmitter', 'thermocouple', 'plc', 'dcs', 'distributed control',
      'pid control', 'control valve', 'field instrumentation', 'analyzer', 'mass flow',
      'process control', 'hart communicator', 'ics',
    ],
    tickets: [T, J, AU],
    ticketMeans:
      'Frequently gated on an instrumentation ticket, but many sites will take a '
      + 'proven electrical or mechanic with process exposure and train the rest.',
    supersedes: ['instrument mechanic'],
    notEqualTo: ['electrician', 'control systems engineer', 'process engineer'],
    nearbyRoles: ['electrician', 'mechanic', 'control systems engineer'],
    notableFor:
      'The highest-demand trade on the FIFO roster — narrow skill, remote sites, and '
      + 'scarce people who can do it.',
    fifo: true,
  },
  {
    id: 'control_systems_engineer',
    name: 'Control Systems Engineer',
    family: 'electrical',
    definition:
      'Designs and troubleshoots the control layer: PLC and DCS programs, SCADA, '
      + 'interlocks, safety systems and the logic that keeps a plant safe.',
    signals: [
      'control systems engineer', 'controls engineer', 'process control engineer',
      'plc programming', 'scada', 'safety instrumented system', 'sis', 'sil', 'plc',
      'ladder logic', 'functional safety', 'iec 61511', 'iec 61131', 'hmi design',
      'historian', 'wincc', 'factory talk',
    ],
    tickets: [],
    ticketMeans:
      'Usually an engineering or technologist qualification rather than a trade ticket. '
      + 'Some jurisdictions offer a controls technologist ticket.',
    supersedes: [],
    notEqualTo: ['instrumentation technician', 'electrical engineer'],
    nearbyRoles: ['instrumentation technician', 'electrical engineer'],
    notableFor: 'Sits between the trades and engineering, and pays accordingly.',
  },

  // ── Mechanical ───────────────────────────────────────────────────────────
  {
    id: 'mechanic',
    name: 'Mechanic',
    family: 'mechanical',
    definition:
      'Repairs and maintains mechanical equipment — pumps, gearboxes, bearings, engines, '
      + 'hydraulics. On site, this is usually the person the whole operation waits for.',
    signals: [
      'mechanic', 'mechanical technician', 'machinist', 'fitter', 'machinist fitter',
      'pump', 'gearbox', 'bearing', 'hydraulic', 'alignment', 'vibration analysis',
      'overhaul', 'strip and rebuild', 'diesel engine', 'engine overhaul', 'compressor',
      'lubrication', 'preventive maintenance', 'condition monitoring',
    ],
    tickets: [T, J, AU],
    ticketMeans: 'A ticket is normally required, though large industrial sites often hire on demonstrated experience.',
    supersedes: ['fitter'],
    notEqualTo: ['mechanical engineer', 'automotive mechanic'],
    nearbyRoles: ['machinist', 'diesel technician'],
    notableFor: 'Broadest demand of any trade; rarely out of work in a resource region.',
  },
  {
    id: 'diesel_tech',
    name: 'Diesel Technician',
    family: 'mechanical',
    definition:
      'Maintains diesel engines and the drivetrain around them — heavy equipment, generators, '
      + 'pumps and marine propulsion.',
    signals: [
      'diesel technician', 'diesel mechanic', 'heavy equipment mechanic', 'engine technician',
      'fuel injection', 'turbocharger', 'turbo', 'engine diagnostic', 'cat', 'caterpillar',
      'komatsu', 'power generation', 'generator maintenance',
    ],
    tickets: [AU, J],
    ticketMeans: 'Site safety tickets are the real gate on FIFO work; the trade itself is often open.',
    supersedes: [],
    notEqualTo: ['mechanic', 'automotive technician'],
    nearbyRoles: ['mechanic', 'heavy equipment operator'],
    notableFor: 'Large FIFO employers hire in bulk and train on site.',
    fifo: true,
  },
  {
    id: 'welder',
    name: 'Welder',
    family: 'welding_fab',
    definition:
      'Joins metal by welding — structural, pressure-retaining or stainless — to a coded '
      + 'procedure. The ticket and the process code both matter: a welder qualified to '
      + '6G carbon steel is not automatically qualified to 6G stainless.',
    signals: [
      'welder', 'welding', 'weld', 'c6g', '6g', 'aws d1.1', 'asme ix', 'asme section ix',
      'fcaw', 'gtaw', 'smaw', 'stick welding', 'mig', 'tig', 'submerged arc',
      'structural welding', 'pressure vessel welding', 'piping', 'weld procedure',
      'wps', 'pqr', 'weld inspection', 'stainless welding', 'overlay',
    ],
    tickets: [T, J, AU, NDT],
    ticketMeans:
      'The procedure qualification matters as much as the ticket. "Welder" alone is '
      + 'not a qualification — the process, position and material are what get tested.',
    supersedes: [],
    notEqualTo: ['welder fabricator', 'gasfitter'],
    nearbyRoles: ['fabricator', 'boilermaker', 'ndt technician'],
    notableFor: 'One of the most in-demand trades on every FIFO roster, at the highest hourly rate.',
    fifo: true,
  },
  {
    id: 'fabricator',
    name: 'Metal Fabricator',
    family: 'welding_fab',
    definition:
      'Cuts, forms and assembles metal — plate work, structural steel, custom machinery — '
      + 'usually from drawings, often in a shop rather than on site.',
    signals: [
      'fabricator', 'metal fabricator', 'fitter welder', 'structural steel', 'steel fabrication',
      'plate work', 'press brake', 'rolling', 'metal forming', 'custom fabrication',
      'shop fabrication', 'blueprint reading', 'shop drawings',
    ],
    tickets: [T, J],
    ticketMeans: 'A ticket is usually expected; shop work often also asks for a welding ticket.',
    supersedes: ['sheet metal worker'],
    notEqualTo: ['welder'],
    nearbyRoles: ['welder', 'machinist'],
    notableFor: 'A route into welding-led work for people who prefer shop over site work.',
  },
  {
    id: 'ndt_tech',
    name: 'NDT Technician',
    family: 'welding_fab',
    definition:
      'Inspects welds and components without destroying them — radiography, ultrasonic, '
      + 'dye penetrant, magnetic particle. Certifies whether a weld is sound.',
    signals: [
      'ndt', 'ndt technician', 'ndt level', 'asnt', 'iso 9712', 'radiography', 'rt',
      'ultrasonic testing', 'ut', 'dye penetrant', 'dpt', 'magnetic particle', 'mpi',
      'eddy current', 'et', 'visual inspection', 'vt', 'weld inspector', 'cwi',
      'aws inspector',
    ],
    tickets: ['ndt'],
    ticketMeans:
      'Certification is the whole job — level and method decide what you are allowed '
      + 'to sign off. Method and Level 2 is the common entry point.',
    supersedes: ['radiographer'],
    notEqualTo: ['quality inspector', 'welder'],
    nearbyRoles: ['welder', 'quality engineer'],
    notableFor: 'Certification-driven and travel-friendly; pairs naturally with welding and inspection work.',
  },
  {
    id: 'boilermaker',
    name: 'Boilermaker',
    family: 'welding_fab',
    definition:
      'Builds and repairs pressure vessels, boilers, tanks and heavy plate work. Metalwork '
      + 'with a code attached.',
    signals: [
      'boilermaker', 'pressure vessel', 'boiler', 'tank fabrication', 'heavy plate',
      'shell and tube', 'alloy steel', 'refractory', 'code stamping', 'ansi b31',
      'asme b31', 'piping spools', 'shop fitting',
    ],
    tickets: [T, J, AU],
    ticketMeans: 'Boilermaker is a journeyperson trade; welding tickets are commonly held alongside.',
    supersedes: [],
    notEqualTo: ['welder', 'pipefitter'],
    nearbyRoles: ['welder', 'pipefitter'],
    notableFor: 'Shop-based, unionised in some regions, and steady rather than seasonal.',
  },
  {
    id: 'pipefitter',
    name: 'Pipefitter',
    family: 'welding_fab',
    definition:
      'Fits, installs and repairs process piping — spool fabrication, tubing, valves and '
      + 'the joints that carry the product.',
    signals: [
      'pipefitter', 'piping', 'pipe fitting', 'spool fabrication', 'isometrics', 'take-off',
      'piping layout', 'tube bending', 'valve installation', 'flange alignment', 'brazing',
      'threading', 'grooving', 'asme b31.3',
    ],
    tickets: [T, J, AU],
    ticketMeans: 'Journeyperson trade in most jurisdictions.',
    supersedes: [],
    notEqualTo: ['plumber', 'welder'],
    nearbyRoles: ['welder', 'boilermaker'],
    notableFor: 'Large on every oil, gas and construction site.',
    fifo: true,
  },

  // ── Construction ─────────────────────────────────────────────────────────
  {
    id: 'carpenter',
    name: 'Carpenter',
    family: 'construction',
    definition:
      'Cuts, fits and installs timber and light-gauge systems — formwork, framing, finish '
      + 'carpentry, and the on-site formwork every concrete pour depends on.',
    signals: [
      'carpenter', 'journeyman carpenter', 'formwork', 'form carpenter', 'framing',
      'timber', 'joinery', 'finish carpenter', 'millwright', 'scaffolder', 'shuttering',
      'concrete formwork', 'wood framing', 'rough carpentry',
    ],
    tickets: [T, J, AU],
    ticketMeans: 'Journeyperson ticket normally required on union and large-contract work.',
    supersedes: ['carpenter helper'],
    notEqualTo: ['construction labourer'],
    nearbyRoles: ['construction labourer', 'scaffolder'],
    notableFor: 'Formwork carpentry is the FIFO-specific variant — remote sites pour concrete constantly.',
    fifo: true,
  },
  {
    id: 'scaffolder',
    name: 'Scaffolder',
    family: 'construction',
    definition:
      'Erects, ties and dismantles scaffolding, and works from it. On industrial sites, '
      + 'often also owns the access and rescue plan.',
    signals: [
      'scaffolder', 'scaffolding', 'scaffold', 'falsework', 'suspended scaffold',
      'tower scaffold', 'cantilever scaffold', 'tie-in', 'scaffold inspection',
      'working at height', 'harness', 'fall arrest',
    ],
    tickets: [AU, J, 'safety'],
    ticketMeans:
      'Working-at-height competence is mandatory and site-specific; scaffold inspection '
      + 'certification is usually employer-provided.',
    supersedes: ['laborer'],
    notEqualTo: ['construction labourer', 'rope access technician'],
    nearbyRoles: ['construction labourer', 'carpenter'],
    notableFor: 'A genuine route up from labouring, and consistently short-staffed on sites.',
    fifo: true,
  },
  {
    id: 'construction_labourer',
    name: 'Construction Labourer',
    family: 'construction',
    definition:
      'The entry role on a site: material handling, housekeeping, assisting trades, and '
      + 'supporting whatever the crew is doing that week.',
    signals: [
      'construction labourer', 'construction laborer', 'labourer', 'laborer', 'site labourer',
      'general labour', 'groundworker', 'site hand', 'formwork labourer', 'site work',
      'cleaner', 'housekeeping', 'material handling',
    ],
    tickets: ['safety'],
    ticketMeans:
      'Usually the easiest role on a site to get, and the one most often listed as "no '
      + 'experience necessary" — which is exactly what it is.',
    supersedes: [],
    notEqualTo: ['carpenter', 'scaffolder'],
    nearbyRoles: ['carpenter', 'scaffolder', 'heavy equipment operator'],
    notableFor:
      'The most common entry point into the trades on a FIFO site, and the role most '
      + 'often paired with a training commitment.',
    fifo: true,
  },
  {
    id: 'heavy_equipment_operator',
    name: 'Heavy Equipment Operator',
    family: 'heavy_equipment',
    definition:
      'Operates dozers, excavators, loaders, haul trucks and graders. On a mine, the haul '
      + 'truck is the job.',
    signals: [
      'heavy equipment operator', 'equipment operator', 'dozer operator', 'excavator operator',
      'loader operator', 'haul truck', 'truck driver mining', 'grader operator',
      'backhoe', 'crane operator', 'mobile crane', 'feller buncher', 'skid steer',
      'articulated dump truck', 'side boom', 'boom operator',
    ],
    tickets: [AU, J, 'safety'],
    ticketMeans:
      'A recognised operator ticket or competency assessment. Many mines run their own '
      + 'training and certification for a specific machine class.',
    supersedes: [],
    notEqualTo: ['truck driver', 'heavy equipment mechanic'],
    nearbyRoles: ['diesel technician', 'construction labourer'],
    notableFor:
      'High rates and easy entry on FIFO, because the ticket is earned on the job rather '
      + 'than bought before it.',
    fifo: true,
  },

  // ── Mining ───────────────────────────────────────────────────────────────
  {
    id: 'underground_miner',
    name: 'Underground Miner',
    family: 'mining',
    definition:
      'Works underground in a mine: development, production, ground support, equipment '
      + 'operation and shotfiring. The core construction role of underground mining.',
    signals: [
      'underground miner', 'production miner', 'construction miner', 'development miner',
      'drill and blast', 'shotfiring', 'shot firer', 'blast crew', 'ground support',
      'scaling', 'scaler', 'jumbo operator', 'bolter', 'roof bolter', 'emulsion',
      'load and haul', 'underground mine', 'coal miner', 'hard rock miner',
      'ventilation raise', 'longwall',
    ],
    tickets: [AU, 'safety'],
    ticketMeans:
      'Site induction and safety certification are mandatory. Shotfiring carries its own '
      + 'blasting licence in most jurisdictions.',
    supersedes: ['miner', 'face worker'],
    notEqualTo: ['open pit miner', 'driller'],
    nearbyRoles: ['heavy equipment operator', 'shotfirer'],
    notableFor: 'The largest single category in the FIFO roster by role count.',
    fifo: true,
  },
  {
    id: 'driller',
    name: 'Driller',
    family: 'mining',
    definition:
      'Operates drilling rigs — exploration diamond drills, production blasthole drills, '
      + 'or oil and gas well drilling, depending on the setting.',
    signals: [
      'driller', 'diamond driller', 'blast hole driller', 'rotary driller', 'drill rig',
      'exploration drilling', 'reverse circulation', 'rc drilling', 'water well driller',
      'well driller', 'top drive', 'mud logging', 'rig hand',
    ],
    tickets: [AU, 'safety'],
    ticketMeans: 'Rig competency assessment plus site safety induction.',
    supersedes: [],
    notEqualTo: ['drill and blast engineer'],
    nearbyRoles: ['underground miner', 'heavy equipment operator'],
    notableFor: 'Oil sands and mineral exploration hire continuously; exploration drilling travels.',
    fifo: true,
  },
  {
    id: 'shotfirer',
    name: 'Shotfirer',
    family: 'mining',
    definition:
      'Loads and fires production blasts and controls the blasting pattern. In Canada this '
      + 'requires a formal Blaster certificate.',
    signals: [
      'shotfirer', 'shot firer', 'blaster', 'blasting', 'blaster certificate', 'explosives',
      'emulsion truck', 'blast design', 'pattern design', 'stemming', 'muckpile',
    ],
    tickets: ['safety'],
    ticketMeans:
      'Blaster certification is a formal licence, not a ticket, and is jurisdiction-specific. '
      + 'It is the most portable credential on this list.',
    supersedes: [],
    notEqualTo: ['driller'],
    nearbyRoles: ['driller', 'underground miner'],
    notableFor: 'A short, formal qualification that unlocks a well-paid specialty.',
    fifo: true,
  },
  {
    id: 'open_pit_miner',
    name: 'Open Pit / Surface Miner',
    family: 'mining',
    definition:
      'Surface mining: pit operations, stripping, haulage, and grade control from the '
      + 'bench rather than underground.',
    signals: [
      'open pit', 'surface miner', 'open pit miner', 'strip mining', 'grade control',
      'pit supervisor', 'bench height', 'haul road', 'stockpile', 'ore grade',
      'mine planning', 'short term planning',
    ],
    tickets: ['safety'],
    ticketMeans: 'Site induction and competency assessment.',
    supersedes: [],
    notEqualTo: ['underground miner'],
    nearbyRoles: ['heavy equipment operator', 'geologist'],
    notableFor: 'Often a supervisory progression from underground or equipment work.',
    fifo: true,
  },

  // ── Oil, gas and pipelines ────────────────────────────────────────────────
  {
    id: 'rig_tech',
    name: 'Rig Technician',
    family: 'oilgas',
    definition:
      'Works on an offshore or land drilling rig maintaining the mechanical and hydraulic '
      + 'systems that keep it operating. The core technical role on a rig.',
    signals: [
      'rig technician', 'rig tech', 'offshore technician', 'drilling technician',
      'roughneck', 'motorman', 'derrickhand', 'floorhand', 'roustabout', 'subsea',
      'blowout preventer', 'bop', 'mud pump', 'shaker', 'separation equipment',
      'rig hand', 'offshore crew',
    ],
    tickets: ['safety', 'ndt'],
    ticketMeans:
      'Offshore survival and HUET-equivalent certification plus the rig\'s own competency '
      + 'matrix. Height work and confined space are daily requirements.',
    supersedes: ['roustabout'],
    notEqualTo: ['petroleum engineer', 'offshore engineer'],
    nearbyRoles: ['pipefitter', 'mechanic', 'welder'],
    notableFor: 'Paid on rotation: 14 on, 14 off is the North Sea norm, and the schedule is the draw.',
    fifo: true,
  },
  {
    id: 'hse_officer',
    name: 'HSE Officer',
    family: 'hse',
    definition:
      'Owns safety on site: permits, toolbox talks, incident investigation, audits and the '
      + 'stop-work authority. A site role with real accountability rather than a certificate.',
    signals: [
      'hse officer', 'hse', 'health safety environment', 'safety officer', 'safety advisor',
      'safety manager', 'toolbox talk', 'permit to work', 'ptw', 'jsa', 'job safety analysis',
      'risk assessment', 'incident investigation', 'lost time injury', 'lti', 'stop work',
      'site inspection', 'auditor',
    ],
    tickets: ['safety'],
    ticketMeans:
      'Site-specific certification is usually provided, but the role itself often requires '
      + 'a recognised safety qualification (NEBOSH, IOSH, or equivalent) for senior posts.',
    supersedes: ['safety officer'],
    notEqualTo: ['safety engineer', 'compliance officer'],
    nearbyRoles: ['superintendent', 'site manager'],
    notableFor: 'Often the first supervisory step on a FIFO site, and a real route to site management.',
    fifo: true,
  },
  {
    id: 'medic',
    name: 'Site Medic',
    family: 'hse',
    definition:
      'Provides medical care at a remote site — often a single practitioner covering a camp '
      + 'of hundreds with medevac capability. Advanced life support and independent practice '
      + 'are the norm.',
    signals: [
      'site medic', 'remote medic', 'offshore medic', 'industrial medic', 'field medic',
      'advanced first aid', 'advanced life support', 'als', 'paramedic', 'emergency responder',
      'medical officer', 'telehealth', 'medevac', 'occupational health',
    ],
    tickets: ['safety'],
    ticketMeans:
      'Registration as a nurse, paramedic or physician, with advanced life support. Scope of '
      + 'practice varies by jurisdiction and is genuinely independent on most sites.',
    supersedes: ['first aid attendant'],
    notEqualTo: ['occupational health nurse'],
    nearbyRoles: ['hse officer'],
    notableFor: 'Polar and offshore sites hire heavily, and the credential is genuinely portable.',
    fifo: true,
  },
  {
    id: 'cook_camp',
    name: 'Camp Cook / Camp Services',
    family: 'logistics',
    definition:
      'Feeds and services a remote camp: cooks, catering staff, and the housekeeping and '
      + 'maintenance that keep the accommodation livable. Entry-level site roles that turn '
      + 'into permanent ones surprisingly often.',
    signals: [
      // "chef" and "cook" are deliberately absent. A Michelin sous chef is a
      // different career from a camp cook, and matching one on the other sends a
      // restaurant CV to a remote site. What identifies this role is the camp
      // context, so only the camp-shaped terms are signals.
      'camp cook', 'catering', 'camp services', 'housekeeping',
      'camp attendant', 'camp maintenance', 'cook helper', 'kitchen', 'baker',
      'camp supervisor', 'accommodation services', 'camp services coordinator',
      'cook on site', 'remote camp', 'fly in camp', 'camp catering', 'galley',
    ],
    tickets: ['safety'],
    ticketMeans: 'Food handling certification is standard; site induction is mandatory.',
    supersedes: [],
    notEqualTo: ['chef', 'sous chef'],
    nearbyRoles: ['construction labourer'],
    notableFor: 'Often the easiest way onto a remote site, and a role that can convert to a permanent kitchen or hospitality post.',
    fifo: true,
  },
  {
    id: 'marine_engineer',
    name: 'Marine Engineer',
    family: 'marine',
    definition:
      'Operates and maintains a ship\'s machinery at sea. Requires flag-state certification; '
      + 'the watches are fixed and the postings are long.',
    signals: [
      'marine engineer', 'ship engineer', 'third engineer', 'second engineer', 'chief engineer',
      'motorman', 'engine room watch', 'flag state', 'class survey', 'dry dock',
      'watchkeeping', 'aboard', 'merchant marine', 'steward',
    ],
    tickets: ['marine', 'safety'],
    ticketMeans:
      'Flag-state certification of competency is mandatory and is the route to sea duty. '
      + 'It is earned through approved sea service.',
    supersedes: [],
    notEqualTo: ['automotive mechanic'],
    nearbyRoles: ['diesel technician', 'mechanic'],
    notableFor: 'A certificate that requires time at sea before it exists — no shortcut, and that is the point.',
    fifo: true,
  },
  {
    id: 'merchant_seaman',
    name: 'Merchant Seaman',
    family: 'marine',
    definition:
      'The deck and engine ratings who keep a vessel working: able seaman, ordinary seaman, '
      + 'motorman, chief mate. Watchkeeping and certification apply.',
    signals: [
      'merchant seaman', 'able seaman', 'ordinary seaman', 'chief mate', 'second mate',
      'deck hand', 'bosun', 'motorman', 'rating', 'watchkeeping', 'cargo work',
      'stevedore', 'hold', 'hatch', 'stowage',
    ],
    tickets: ['marine'],
    ticketMeans: 'Flag-state certification, again earned through approved sea service.',
    supersedes: ['deck hand'],
    notEqualTo: ['marine engineer'],
    nearbyRoles: ['marine engineer'],
    notableFor: 'The largest single employer of maritime labour, and a genuine career with certification.',
    fifo: true,
  },
];

/** Signal text that proves a ticket without naming it. Kept separate so a resume
 *  listing "Red Seal Journeyperson Electrician" registers the ticket as well as the role. */
export const TICKET_SIGNALS = [
  { ticket: 'red_seal', re: /\bred\s?seal\b/i },
  { ticket: 'journeyman', re: /\bjourney(?:person|man)\b/i },
  { ticket: 'apprenticeship', re: /\bapprentice(?:ship)?\b|\bapprenticed\b/i },
  { ticket: 'ticket_au', re: /\b(?:asic|trade\s+qualification|qb\s?card|certificate\s+of\s+competence)\b/i },
  { ticket: 'ndt', re: /\b(?:ndt|asnt|iso\s?9712|radiograph\w*|dye\s+penetrant|magnetic\s+particle)\b/i },
  { ticket: 'marine', re: /\b(?:flag\s+state|watch\s?keep\w*|oow|marine\s+certificate|class\s+survey)\b/i },
  { ticket: 'safety', re: /\b(?:h2s|scba|confined\s+space|working\s+at\s+height|fall\s+arrest|first\s+aid|huet|survival)\b/i },

  // Credentials from titles-professions.mjs. Kept here, beside the trade tickets,
  // because detectTickets() has one registry and a resume saying "CDL Class A" or
  // "RN, BSN" is stating a licence exactly as "Red Seal" does.
  { ticket: 'fmcsa', re: /\b(?:cdl(?:\s+class\s+[ab])?|class\s+[ab]\s+cdl|dot\s+medical|hazmat\s+endorsement|medical\s+examiner\s+certificate)\b/i },
  // The Canadian provincial driver's licence, which is what most heavy-equipment,
  // delivery and construction postings in this market actually ask for.
  //
  // It was matched only by `fmcsa` on the US spelling and by `state_cdl` on
  // "provincial CDL", so "Class 5 drivers licence required" — the single most
  // common way a Canadian employer states this — detected nothing. The posting
  // went live with no ticket on it, which means a candidate without the licence
  // would not be told to get it, and one with the licence gets no credit for
  // having it.
  { ticket: 'state_cdl', re: /\b(?:class\s+[1-5]\s+(?:driver'?s?\s+)?licen[cs]e|driver'?s?\s+licen[cs]e\s+class\s+[1-5]|provincial\s+(?:driver'?s?\s+)?licen[cs]e|provincial\s+cdl|cdl\s+(?:class\s+[ab]\s+)?canada|azip|usdot)\b/i },
  { ticket: 'dangerous_goods', re: /\b(?:hazmat|tdg|tdg\s+training|dangerous\s+goods|h-n\s+endorsement|tanker\s+endorsement)\b/i },
  { ticket: 'nursing_license', re: /\b(?:rn\b|bsn|msn|adn|nclex|nurs(?:e|ing)\s+licen[cs]e|state\s+nurs(?:e|ing)\s+licen[cs]e)\b/i },
  { ticket: 'medical_license', re: /\b(?:medical\s+licen[cs]e|physician\s+licen[cs]e|medical\s+council|state\s+board\s+of\s+medical|rph\b|pharmd|rt\b|\brn\b)\b/i },
  { ticket: 'teaching_certificate', re: /\b(?:teaching\s+(?:certificat|certificat|licen[cs]e)|teacher\s+licen[cs]e|state\s+certificat\w*\s+in\s+teaching|pgce|certified\s+teacher)\b/i },
  { ticket: 'peace_officer', re: /\b(?:peace\s+officer|basic\s+peace\s+officer|bpo\s+certificat|police\s+academy|entry\s+level\s+officer)\b/i },
  { ticket: 'firefighter_cert', re: /\b(?:ifac\s+certificat|firefighter\s+[12]\b|fire\s+service\s+accreditation|nfpa\s+\w*\s*certificat)\b/i },
  { ticket: 'correction_officer', re: /\b(?:corrections?\s+(?:officer|certification)|correctional\s+officer|prison\s+officer)\b/i },
  { ticket: 'aircrew', re: /\b(?:atp\b|commercial\s+pilot|private\s+pilot|instrument\s+rating|type\s+rated|part\s*1(?:21|35)|faa\s+(?:rating|certificate)|transport\s+canada\s+rating)\b/i },
  { ticket: 'maritime_cert', re: /\b(?:flag\s+state|maritime\s+certificat|oow\s+(?:unlimited|deck|engine)|watch\s?keep\w*|class\s+survey)\b/i },
  { ticket: 'first_aid_instructor', re: /\b(?:first\s+aid\s+instructor|cfi\b|cfii\b|emergency\s+care\s+instructor|itc)\b/i },
];

export default {
  TRADE_TITLES, TRADE_FAMILIES, TICKET_SYSTEMS, TICKET_SIGNALS,
};
