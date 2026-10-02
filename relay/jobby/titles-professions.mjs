/**
 * relay/jobby/titles-professions.mjs — the four remaining gap families
 *
 * Fills the holes named after the trades pass: transport and logistics, healthcare,
 * public sector, and the trades supervisory layer.
 *
 * ── Why these are in one file and not in titles-trades.mjs ─────────────────
 *
 * Because the shared property is not that they are trades — it is that they are
 * **licence-and-certificate professions**, and that the licence is the whole
 * difficulty. A CDL Class 1 is a federal licence with a medical certificate. A
 * nurse needs a state licence and, often, a compact. A teacher needs a teaching
 * certificate in a specific state, and that certificate does not travel.
 *
 * So `CERTIFYING_BODY` and `jurisdictionScoped` are first-class here for the same
 * reason `tickets` is first-class in the trades. The pattern is the same problem
 * in a different costume: a candidate who holds the credential in the wrong
 * jurisdiction is qualified and employable, but not *here*, and saying so
 * plainly is more useful than a confident match.
 *
 * The FIFO roster independently contains a fuel tanker driver (R016) and a
 * production haul-truck operator (R013), so transport is measured demand rather
 * than a gap I decided to fill on a hunch.
 */

export const PROFESSION_FAMILIES = {
  road_transport: 'Road transport',
  logistics: 'Logistics and distribution',
  aviation: 'Aviation',
  maritime: 'Maritime and port',
  clinical: 'Clinical',
  allied_health: 'Allied health',
  care: 'Care and social services',
  teaching: 'Teaching',
  law_enforcement: 'Law enforcement',
  fire_rescue: 'Fire and rescue',
  corrections: 'Corrections',
  supervision: 'Site supervision',
  project_delivery: 'Project delivery',
};

/** What issues the credential, and whether it travels across jurisdictions. */
export const CERTIFYING_BODY = {
  fmcsa: {
    key: 'fmcsa',
    label: 'FMCSA CDL',
    where: 'United States',
    jurisdictionScoped: false,
    note: 'Federal. Transfers between US states without re-testing, but not outside the US.',
  },
  state_cdl: {
    key: 'state_cdl',
    label: 'Provincial CDL equivalent',
    where: 'Canada',
    jurisdictionScoped: true,
    note: 'Issued per province. Not transferable between provinces without re-testing.',
  },
  nursing_license: {
    key: 'nursing_license',
    label: 'State nursing licence',
    where: 'United States',
    jurisdictionScoped: true,
    note: 'State-issued, though the Nurse Licensure Compact covers most states. Also requires reciprocity or an exam abroad.',
  },
  medical_license: {
    key: 'medical_license',
    label: 'Medical licence',
    where: 'Jurisdiction-dependent',
    jurisdictionScoped: true,
    note: 'State or provincial. Obtaining one from outside the country is a separate, long process — usually employer-sponsored.',
  },
  teaching_certificate: {
    key: 'teaching_certificate',
    label: 'Teaching certificate',
    where: 'State or province',
    jurisdictionScoped: true,
    note: 'Almost never transfers. This is the single most common reason a qualified teacher cannot teach in the state they moved to.',
  },
  peace_officer: {
    key: 'peace_officer',
    label: 'Peace officer certification',
    where: 'Agency',
    jurisdictionScoped: true,
    note: 'Agency-specific. Certification follows the badge and ends with it.',
  },
  firefighter_cert: {
    key: 'firefighter_cert',
    label: 'Firefighter certification',
    where: 'State/province and department',
    jurisdictionScoped: true,
    note: 'International Fire Service Accreditation Congress certification, plus department-specific training.',
  },
  correction_officer: {
    key: 'correction_officer',
    label: 'Corrections certification',
    where: 'Agency',
    jurisdictionScoped: true,
    note: 'Agency-specific, usually including a background and fitness standard.',
  },
  dangerous_goods: {
    key: 'dangerous_goods',
    label: 'Dangerous goods endorsement',
    where: 'Jurisdiction-dependent',
    jurisdictionScoped: false,
    note: 'A CDL endorsement (US HAZMAT) or a TDG training certificate (Canada). Required to transport fuel, chemicals or explosives.',
  },
  aircrew: {
    key: 'aircrew',
    label: 'Aircrew licence',
    where: 'National aviation authority',
    jurisdictionScoped: true,
    note: 'Issued by the national authority (FAA, Transport Canada, CASA). Recognition between authorities varies and often requires a check ride.',
  },
  maritime_cert: {
    key: 'maritime_cert',
    label: 'Flag-state certificate',
    where: 'Flag state',
    jurisdictionScoped: true,
    note: 'Issued by, and tied to, a flag state. See titles-trades.mjs for the watchkeeping equivalent.',
  },
  first_aid_instructor: {
    key: 'first_aid_instructor',
    label: 'Instructor certification',
    where: 'Certifying body',
    jurisdictionScoped: false,
    note: 'Often the route into teaching the credential rather than practising it.',
  },
};

/** @type {import('./titles-trades.mjs').TradeTitle[]} */
export const PROFESSION_TITLES = [
  // ── Road transport ───────────────────────────────────────────────────────
  {
    id: 'cdl_driver',
    name: 'CDL Truck Driver',
    family: 'road_transport',
    definition:
      'Drives a commercial motor vehicle over 26,000 pounds: long-haul, regional, or local. '
      + 'The Class A licence plus a medical card is the gate, and the hours-of-service '
      + 'rules are as much a part of the job as the driving.',
    signals: [
      'cdl', 'class a', 'class a cdl', 'commercial driver', 'truck driver', 'team driver',
      'otr', 'over the road', 'long haul', 'tractor trailer', 'flatbed', 'dry van',
      'reefer', 'tanker', 'hazmat', 'h-n endorsement', 'tanker endorsement',
      'dot medical', 'medical examiner certificate', 'eld', 'electronic logging',
      'hos', 'hours of service', 'air brake', 'pre trip', 'dock',
    ],
    tickets: ['fmcsa', 'state_cdl', 'dangerous_goods'],
    ticketMeans:
      'A CDL is required above the weight threshold and cannot be substituted by '
      + 'experience. A Class A plus the right endorsement decides what you can legally '
      + 'haul — hazmat and tanker are separate endorsements, not part of the base.',
    supersedes: ['truck driver', 'teamster driver'],
    notEqualTo: ['delivery driver', 'courier'],
    nearbyRoles: ['dispatcher', 'warehouse associate', 'heavy equipment operator'],
    notableFor:
      'Among the highest-paid entry-to-level work available without a degree, which is why it '
      + 'is a common second career — and the reason the credential, not the CV, is what moves.',
  },
  {
    id: 'owner_operator',
    name: 'Owner-Operator',
    family: 'road_transport',
    definition:
      'A driver who owns the truck and runs it as a small business: equipment financing, '
      + 'insurance, dispatch or self-dispatch, and the margin left after all of it.',
    signals: [
      'owner operator', 'owner-operator', 'small fleet', 'trucking company', 'my own truck',
      'truck owner', 'freight brokerage', 'factoring', 'owner operator training',
      'dot number', 'mc number', 'carrier', 'scac',
    ],
    tickets: ['fmcsa', 'state_cdl'],
    ticketMeans: 'A CDL plus operating authority (USDOT/MC numbers). A certificate of insurance is also mandatory.',
    supersedes: [],
    notEqualTo: ['broker', 'freight broker'],
    nearbyRoles: ['cdl_driver', 'freight_broker'],
    notableFor:
      'A common misreading: the advertised pay is gross revenue, not take-home. The honest '
      + 'picture requires fuel, maintenance, insurance and downtime. Worth saying so.',
  },
  {
    id: 'freight_broker',
    name: 'Freight Broker',
    family: 'logistics',
    definition:
      'Arranges the movement of freight between shippers and carriers without touching the '
      + 'load. Office-based, commission or salary, and mostly relationship and negotiation.',
    signals: [
      'freight broker', 'brokerage', 'logistics broker', 'truck brokerage', 'shipper',
      'load board', 'lanes', 'rate per mile', 'shipper contract', 'dedicated lane',
      'dispatcher', 'freight sales', 'spot load', 'contract freight',
    ],
    tickets: ['fmcsa'],
    ticketMeans:
      'Broker authority needs registration rather than a driving licence — so this is '
      + 'genuinely open to people who cannot or do not drive.',
    supersedes: ['dispatcher'],
    notEqualTo: ['dispatcher', 'owner operator'],
    nearbyRoles: ['cdl_driver', 'logistics coordinator'],
    notableFor:
      'A realistic route into logistics without a licence, and often the first role in the industry.',
  },
  {
    id: 'warehouse_associate',
    name: 'Warehouse Associate',
    family: 'logistics',
    definition:
      'Picks, packs, receives and moves goods inside a distribution centre. Forklift '
      + 'certification, physical demands, and shift work are the defining features.',
    signals: [
      'warehouse associate', 'warehouse worker', 'picker', 'packer', 'picker packer',
      'forklift', 'reach truck', 'pallet jack', 'order picker', 'inventory control',
      'receiving dock', 'cross dock', 'distribution centre', 'fulfilment',
      'cycle count', 'rf scanner',
    ],
    tickets: [],
    ticketMeans: 'Usually no licence required. Forklift certification is employer-provided and often within days.',
    supersedes: ['picker'],
    notEqualTo: ['forklift operator', 'logistics coordinator'],
    nearbyRoles: ['forklift_operator', 'logistics_coordinator'],
    notableFor: 'The most common entry point into logistics, and a genuine route to supervision.',
  },
  {
    id: 'forklift_operator',
    name: 'Forklift Operator',
    family: 'logistics',
    definition:
      'Operates counterbalance, reach or side-loader forklifts in a yard or warehouse. A '
      + 'certification rather than a licence, but a safety-critical one.',
    signals: [
      'forklift operator', 'counterbalance', 'reach truck', 'side loader', 'telehandler',
      'clamp attachment', 'yard operator', 'material handling', 'mhe',
    ],
    tickets: [],
    ticketMeans:
      'Certification is usually employer- or site-provided and expires, so it must be renewed. '
      + 'Not a licence, and the distinction matters on sites that require the ticket.',
    supersedes: [],
    notEqualTo: ['warehouse associate'],
    nearbyRoles: ['warehouse_associate', 'heavy_equipment_operator'],
    notableFor: 'Frequently bundled into a warehouse role rather than existing separately.',
  },
  {
    id: 'logistics_coordinator',
    name: 'Logistics Coordinator',
    family: 'logistics',
    definition:
      'Keeps shipments moving on plan: schedules carriers, tracks exceptions, and manages '
      + 'the documentation that customs and compliance depend on.',
    signals: [
      'logistics coordinator', 'logistics specialist', 'shipment coordinator', 'freight coordinator',
      'transport coordinator', 'supply chain coordinator', 'shipping clerk', 'documentation',
      'customs', 'bill of lading', 'b/l', 'commercial invoice', 'incoterms', 'customs clearance',
      'cargo release', 'delivery appointment',
    ],
    tickets: [],
    ticketMeans: 'No licence. Incoterms and customs knowledge is the actual qualification.',
    supersedes: ['shipping clerk'],
    notEqualTo: ['freight_broker', 'procurement specialist'],
    nearbyRoles: ['freight_broker', 'procurement_specialist'],
    notableFor: 'The documentation role is where most cross-border shipping actually stalls.',
  },
  {
    id: 'customs_broker',
    name: 'Customs Broker',
    family: 'logistics',
    definition:
      'Licensed to prepare and file import and export entries on someone else\'s behalf. '
      + 'A federal licence with a written exam, rare in its in-person form.',
    signals: [
      'customs broker', 'customs entry', 'import entry', 'export declaration', 'aec',
      'inbond', 'drawback', 'bonded warehouse', 'duty drawback', 'hts code', 'tariff classification',
      'origin determination', 'post summary correction',
    ],
    tickets: [],
    ticketMeans: 'A customs broker licence is required — it is an occupational licence, not a certificate.',
    supersedes: [],
    notEqualTo: ['freight_broker', 'trade compliance analyst'],
    nearbyRoles: ['logistics_coordinator'],
    notableFor: 'One of the few logistics roles where the licence is the qualification outright.',
  },

  // ── Aviation ─────────────────────────────────────────────────────────────
  {
    id: 'atp_pilot',
    name: 'Airline Transport Pilot',
    family: 'aviation',
    definition:
      'A commercial pilot carrying passengers or freight for an airline: type-rated, '
      + 'under an airline operating certificate, and flying to a duty-time schedule.',
    signals: [
      'atp', 'airline transport pilot', 'commercial pilot', 'captain', 'first officer',
      'type rated', 'line check', 'check ride', 'instrument rating', 'multi engine',
      'glass cockpit', 'efb', 'part 121', 'part 135', 'flight hours', 'line check hours',
      'senior first officer', 'captain upgrade',
    ],
    tickets: ['aircrew'],
    ticketMeans:
      'A commercial licence with instrument and multi-engine ratings, plus a type rating '
      + 'for the specific aircraft. Airlines hire ATP with 1,500 hours; ATP-minimum-1500 '
      + 'is the regulatory floor, not the hiring bar.',
    supersedes: [],
    notEqualTo: ['flight instructor', 'chief pilot'],
    nearbyRoles: ['instructor_pilot', 'dispatcher'],
    notableFor:
      'The hours requirement dominates: the licence is achievable in about 250 hours, the '
      + 'airline job needs far more. Worth saying, because candidates assume the licence is the gate.',
  },
  {
    id: 'instructor_pilot',
    name: 'Flight Instructor',
    family: 'aviation',
    definition:
      'Teaches pilots, and owns the signature on a student\'s certificate. Usually requires '
      + 'commercial experience first, and CFIs are in short supply almost everywhere.',
    signals: [
      'flight instructor', 'cfi', 'cfii', 'instructor pilot', 'instructing', 'ground school instructor',
      'flight school instructor', 'check pilot', 'safety pilot', 'maintenance pilot',
    ],
    tickets: ['aircrew', 'first_aid_instructor'],
    ticketMeans: 'A commercial certificate with an instructor endorsement, plus flight review currency.',
    supersedes: [],
    notEqualTo: ['atp_pilot', 'ground school teacher'],
    nearbyRoles: ['atp_pilot'],
    notableFor: 'Consistently in short supply — a genuine shortage profession.',
  },

  // ── Maritime (non-seagoing) ──────────────────────────────────────────────
  {
    id: 'port_worker',
    name: 'Port / Terminal Worker',
    family: 'maritime',
    definition:
      'Works a container terminal or bulk berth: crane operation, lashing, tallying, and '
      + 'the traffic coordination that moves a vessel in and out.',
    signals: [
      'port worker', 'terminal operator', 'container terminal', 'dockworker', 'stevedore',
      'lashing', 'tally clerk', 'crane operator', 'ship loader', 'shiploader', 'berth',
      'wharf', 'container handling', 'yard crane', 'reach stacker', 'straddle carrier',
    ],
    tickets: [],
    ticketMeans: 'Terminal-specific safety induction. Crane operations usually require terminal certification.',
    supersedes: ['dockworker'],
    notEqualTo: ['merchant_seaman', 'truck_driver'],
    nearbyRoles: ['cdl_driver', 'heavy_equipment_operator'],
    notableFor: 'Physically demanding, shift-based, and often closed to applicants without prior terminal experience.',
  },

  // ── Clinical ─────────────────────────────────────────────────────────────
  {
    id: 'registered_nurse',
    name: 'Registered Nurse',
    family: 'clinical',
    definition:
      'Assesses, administers and coordinates nursing care under a nursing licence. The '
      + 'largest health profession, and the one with the widest gap between demand and supply.',
    signals: [
      'registered nurse', 'rn', 'bsn', 'bachelor of science in nursing', 'nursing degree',
      'adn', 'associate degree in nursing', 'nurse', 'nursing', 'patient assessment',
      'care plan', 'iv therapy', 'triage', 'ward nursing', 'clinical nurse',
      'nursing license', 'nursing council', 'nclex', 'charge nurse', 'nurse manager',
      'clinical nurse specialist', 'np', 'nurse practitioner',
    ],
    tickets: ['nursing_license'],
    ticketMeans:
      'A nursing licence in the state or province of practice. Licences do not generally '
      + 'travel internationally — an overseas nurse plans for NCLEX or an equivalent exam '
      + 'and often for a recruitment agency as well.',
    supersedes: [],
    notEqualTo: ['medical_assistant', 'paramedic', 'nursing_aide'],
    nearbyRoles: ['paramedic', 'nurse_practitioner'],
    notableFor:
      'A compact makes many states mutually recognisable, but a nurse educated elsewhere '
      + 'is still starting from the top of a licensing process, not a signature.',
  },
  {
    id: 'nurse_practitioner',
    name: 'Nurse Practitioner',
    family: 'clinical',
    definition:
      'An advanced-practice nurse with prescriptive and diagnostic authority, working '
      + 'independently rather than under a physician. Currently the fastest-growing role in '
      + 'the profession.',
    signals: [
      'nurse practitioner', 'np', 'fnp', 'anp', 'dnp', 'adult nurse practitioner',
      'family nurse practitioner', 'psychiatric np', 'acute care np', 'prescriptive authority',
      'advanced practice nurse', 'aprn', 'differential diagnosis', 'patient management',
    ],
    tickets: ['nursing_license'],
    ticketMeans: 'An RN licence plus a graduate degree in the specialty and a separate state NP licence and DEA registration.',
    supersedes: [],
    notEqualTo: ['physician assistant', 'physician'],
    nearbyRoles: ['registered_nurse', 'physician_assistant'],
    notableFor: 'An advanced qualification whose main attraction is the scope of practice, not the pay.',
  },
  {
    id: 'paramedic',
    name: 'Paramedic',
    family: 'clinical',
    definition:
      'The senior pre-hospital clinician: assesses, treats, transports, and works to a '
      + 'defined scope under a medical director. Progresses EMT to paramedic.',
    signals: [
      'paramedic', 'advanced life support', 'als', 'als provider', 'critical care transport',
      'ccp', 'ems', 'emergency medical services', 'prehospital', 'run sheet', 'pci',
      'protocol', 'base station', 'medical control', 'intubation', 'cardioversion',
      'field paramedic', 'community paramedic', 'wilderness medic',
    ],
    tickets: ['medical_license', 'first_aid_instructor'],
    ticketMeans:
      'State or provincial scope-of-practice certification, with the employer holding the '
      + 'medical authority. Internationally, recognition varies widely and some jurisdictions '
      + 'require a bridging assessment.',
    supersedes: ['emt'],
    notEqualTo: ['emt', 'first_responder', 'registered_nurse'],
    nearbyRoles: ['registered_nurse', 'emergency_care_physician'],
    notableFor:
      'The FIFO roster pays premium rates for site medics with ALS. The credential travels '
      + 'well inside a country and unevenly between them.',
  },
  {
    id: 'emergency_care_physician',
    name: 'Emergency Medicine Physician',
    family: 'clinical',
    definition:
      'A physician working in an emergency department: resuscitations, trauma, and decisions '
      + 'made without warning. Board-certified or board-eligible in emergency medicine.',
    signals: [
      'emergency medicine', 'emergency physician', 'er doctor', 'emergency department physician',
      'ed physician', 'board certified emergency medicine', 'residency emergency medicine',
      'trauma', 'resuscitation', 'intubation', 'central line', 'ems director',
      'medical director', 'triage physician',
    ],
    tickets: ['medical_license'],
    ticketMeans:
      'Medical licence plus residency in emergency medicine and board certification. For '
      + 'international recruitment this is a source-country licence and an employer-supported '
      + 'pathway to local registration.',
    supersedes: [],
    notEqualTo: ['paramedic', 'urgent_care'],
    nearbyRoles: ['paramedic', 'hospitalist'],
    notableFor: 'Site and remote-ED work exists specifically for this credential, at above-market rates.',
  },
  {
    id: 'pharmacist',
    name: 'Pharmacist',
    family: 'clinical',
    definition:
      'Dispenses and compounds medication, checks interactions, and advises on therapy. '
      + 'One of the most geographically portable clinical credentials in the profession.',
    signals: [
      'pharmacist', 'pharmd', 'pharm', 'pharmacy', 'rph', 'dispensing', 'compounding',
      'drug interaction', 'formulary', 'clinical pharmacy', 'hospital pharmacy',
      'pharmacy technician', 'pharmacies act',
    ],
    tickets: [],
    ticketMeans: 'A state pharmacy licence plus the PharmD degree. International applicants need the local exam route.',
    supersedes: ['pharmacy technician'],
    notEqualTo: ['pharmacy_technician', 'pharmaceutical_sales'],
    nearbyRoles: ['nurse_practitioner'],
    notableFor: 'Pharmacy technician is a common entry point into the profession.',
  },

  // ── Allied health ────────────────────────────────────────────────────────
  {
    id: 'respiratory_therapist',
    name: 'Respiratory Therapist',
    family: 'allied_health',
    definition:
      'Diagnoses and treats breathing problems: ventilator management, airway support, and '
      + 'pulmonary function testing. A credentialed allied-health role distinct from nursing.',
    signals: [
      'respiratory therapist', 'respiratory therapy', 'rRT', 'ventilator management',
      'weaning', 'intubation', 'airway management', 'spirometry', 'pulmonary function test',
      'pft', 'nebulizer', 'aerosol', 'oxygen therapy', 'cpap', 'niv', 'hyperbaric',
      'polysomnography',
    ],
    tickets: ['medical_license'],
    ticketMeans: 'State/provincial licence as a respiratory care practitioner.',
    supersedes: [],
    notEqualTo: ['respiratory_nurse', 'caregiver'],
    nearbyRoles: ['registered_nurse', 'paramedic'],
    notableFor: 'Chronic shortages in almost every market, with employment secured before graduation.',
  },
  {
    id: 'medical_imaging_tech',
    name: 'Medical Imaging Technologist',
    family: 'allied_health',
    definition:
      'Produces the images clinicians read: radiography, CT, MRI, mammography, ultrasound. '
      + 'Credentialed and highly portable between facilities.',
    signals: [
      'radiologic technologist', 'radiographer', 'radiology technologist', 'x-ray technologist',
      'medical imaging', 'ct technologist', 'mri technologist', 'mammography',
      'sonographer', 'ultrasound technologist', 'cardiac sonographer', 'sonography',
      'fluoroscopy', 'cath lab tech', 'interventional radiology', 'dose',
    ],
    tickets: ['medical_license'],
    ticketMeans: 'An ARRT or equivalent certification, plus a state permit for some modalities.',
    supersedes: [],
    notEqualTo: ['radiologist', 'medical_assistant'],
    nearbyRoles: ['respiratory_therapist'],
    notableFor: 'One of the most internationally recognised allied-health credentials; imaging education is widely portable.',
  },
  {
    id: 'medical_lab_scientist',
    name: 'Medical Laboratory Scientist',
    family: 'allied_health',
    definition:
      'Runs the diagnostic testing behind every clinical decision: haematology, chemistry, '
      + 'microbiology, and increasingly the molecular panels that replace guesswork.',
    signals: [
      'medical laboratory scientist', 'medical laboratory technologist', 'mlt', 'med tech',
      'clinical laboratory', 'haematology', 'hematology', 'microbiology', 'chemistry',
      'serology', 'histology', 'cytology', 'molecular diagnostics', 'pcr', 'mass spectrometry',
      'blood bank', 'transfusion medicine', 'phlebotomist',
    ],
    tickets: ['medical_license'],
    ticketMeans: 'Certification by a national credentialing body (ASCP or equivalent). Widely recognised internationally.',
    supersedes: ['medical lab technician'],
    notEqualTo: ['biomedical_scientist', 'research_scientist'],
    nearbyRoles: ['pharmacist'],
    notableFor: 'The least visible clinical role, and the one every diagnosis depends on.',
  },
  {
    id: 'physical_therapist',
    name: 'Physical Therapist',
    family: 'allied_health',
    definition:
      'Assesses movement and treats injury and disability with exercise, manual therapy and '
      + 'education. A licensed profession with direct-patient contact throughout.',
    signals: [
      'physical therapist', 'physiotherapist', 'physio', 'pt', 'dpt', 'physical therapy',
      'physiotherapy', 'rehabilitation', 'musculoskeletal', 'orthopaedic', 'sports rehabilitation',
      'gait analysis', 'manual therapy', 'dry needling', 'hydrotherapy',
    ],
    tickets: ['medical_license'],
    ticketMeans: 'A DPT or equivalent plus a state/provincial licence to practise.',
    supersedes: [],
    notEqualTo: ['physical_therapy_assistant', 'chiropractor', 'occupational_therapist'],
    nearbyRoles: ['occupational_therapist'],
    notableFor: 'Direct access (no physician referral required) in most jurisdictions, which is why demand is so consistent.',
  },
  {
    id: 'occupational_therapist',
    name: 'Occupational Therapist',
    family: 'allied_health',
    definition:
      'Helps people regain the ability to do the things their daily life requires — at work, '
      + 'at home, or after an injury. Distinct from physical therapy in both focus and training.',
    signals: [
      'occupational therapist', 'occupational therapy', 'ot', 'otl', 'activity of daily living',
      'adl', 'hand therapy', 'pediatric occupational therapy', 'cognitive rehabilitation',
      'ergonomic assessment', 'assistive technology', 'splinting', 'return to work',
    ],
    tickets: ['medical_license'],
    ticketMeans: 'A master\'s or doctorate in OT plus a licence to practise in the jurisdiction.',
    supersedes: [],
    notEqualTo: ['physical_therapist', 'occupational_therapy_assistant'],
    nearbyRoles: ['physical_therapist'],
    notableFor: 'Frequently confused with physical therapy by candidates, and worth distinguishing explicitly.',
  },

  // ── Care and social services ─────────────────────────────────────────────
  {
    id: 'nursing_aide',
    name: 'Nursing Aide / Care Assistant',
    family: 'care',
    definition:
      'Assists with daily living, vital signs and personal care under clinical supervision. '
      + 'The most common entry point into healthcare, and a genuine career on its own terms.',
    signals: [
      'nursing assistant', 'nursing aide', 'care assistant', 'care aide', 'health care aide',
      'hca', 'pca', 'personal care attendant', 'continuing care attendant', 'support worker',
      'vital signs', 'activities of daily living', 'dementia care', 'personal care',
    ],
    tickets: [],
    ticketMeans: 'A short certificate course is usually required and employer-provided. No licence.',
    supersedes: [],
    notEqualTo: ['registered_nurse', 'caregiver'],
    nearbyRoles: ['registered_nurse'],
    notableFor: 'A real route into nursing and one of the shortest credential-to-job paths in healthcare.',
  },
  {
    id: 'social_worker',
    name: 'Social Worker',
    family: 'care',
    definition:
      'Assesses clients\' circumstances and connects them to services: safeguarding, '
      + 'bereavement, addiction, family intervention and discharge planning.',
    signals: [
      'social worker', 'social work', 'msw', 'bsw', 'lcsw', 'case management', 'case manager',
      'safeguarding', 'child protection', 'protective services', 'bereavement',
      'addiction counselling', 'substance abuse', 'discharge planning', 'social care',
      'mental health support', 'advocacy',
    ],
    tickets: [],
    ticketMeans:
      'A degree in social work plus a licence or registration in most jurisdictions. '
      + 'Also requires a clear background check, which is a real barrier after a career gap.',
    supersedes: ['counsellor'],
    notEqualTo: ['counsellor', 'psychologist'],
    nearbyRoles: ['registered_nurse', 'mental_health_counselor'],
    notableFor: 'The background check is the practical obstacle, more often than the degree.',
  },
  {
    id: 'mental_health_counselor',
    name: 'Mental Health Counselor',
    family: 'care',
    definition:
      'Provides counselling and psychotherapy under a licence, working with individuals, '
      + 'couples, families and groups. A licensed profession distinct from social work.',
    signals: [
      'mental health counselor', 'mental health counsellor', 'therapist', 'counsellor',
      'counselor', 'lpc', 'lmft', 'lcsw', 'psychotherapy', 'cbt', 'cognitive behavioral therapy',
      'dbt', 'family therapy', 'couples therapy', 'trauma informed', 'emdr',
      'substance abuse counselor', 'addiction counselor',
    ],
    tickets: [],
    ticketMeans: 'A master\'s degree and a state/provincial licence as a professional counsellor.',
    supersedes: [],
    notEqualTo: ['psychologist', 'social_worker'],
    nearbyRoles: ['social_worker', 'psychologist'],
    notableFor: 'Licensure now often requires supervised hours, which matters for anyone changing career later in life.',
  },

  // ── Teaching ─────────────────────────────────────────────────────────────
  {
    id: 'teacher',
    name: 'Teacher',
    family: 'teaching',
    definition:
      'Teaches a curriculum to a class, assesses against standards, and manages a classroom. '
      + 'The credential is state- or province-specific and is the single largest obstacle to '
      + 'teaching somewhere other than where you trained.',
    signals: [
      'teacher', 'teaching', 'classroom', 'classroom teacher', 'educator', 'k-12',
      'primary teacher', 'elementary teacher', 'secondary teacher', 'high school teacher',
      'curriculum', 'lesson planning', 'student assessment', 'gradebook', 'classroom management',
      'pedagogy', 'teaching certificate', 'licensure', 'practicum', 'student teaching',
      'multigrade', 'special education', 'iep', 'learning support assistant',
    ],
    tickets: ['teaching_certificate'],
    ticketMeans:
      'A teaching certificate or licence in the jurisdiction of the job. It does not transfer '
      + 'between states or provinces, and an unqualified teacher may work on a provisional or '
      + 'emergency permit with a lower salary and a fixed term.',
    supersedes: ['teaching assistant'],
    notEqualTo: ['teaching_assistant', 'trainer', 'lecturer'],
    nearbyRoles: ['teaching_assistant', 'counsellor'],
    notableFor:
      'The most jurisdiction-locked profession in this library. A teacher who moves states '
      + 'is frequently unqualified on arrival despite years of experience, and the certificate '
      + 'is the thing that decides it.',
  },
  {
    id: 'teaching_assistant',
    name: 'Teaching Assistant',
    family: 'teaching',
    definition:
      'Supports a classroom teacher: supervision, one-to-one support, materials, and '
      + 'behaviour management under the teacher\'s direction. Entry-level, usually no degree required.',
    signals: [
      'teaching assistant', 'teaching aide', 'classroom aide', 'education assistant',
      'learning support assistant', 'lsa', 'paraeducator', 'para-professional',
      'student support', 'one to one support', 'classroom support',
    ],
    tickets: [],
    ticketMeans: 'No teaching certificate needed; a background check is standard.',
    supersedes: [],
    notEqualTo: ['teacher'],
    nearbyRoles: ['teacher'],
    notableFor: 'A common entry route into education, and sometimes a paid step toward certification.',
  },
  {
    id: 'trainer',
    name: 'Corporate Trainer',
    family: 'teaching',
    definition:
      'Designs and delivers training in a business: curriculum, facilitation, and assessment '
      + 'of whether it worked.',
    signals: [
      'corporate trainer', 'training specialist', 'learning and development', 'l&d',
      'instructional designer', 'facilitator', 'training manager', 'elearning',
      'adult learning', 'andragogy', 'curriculum development', 'training needs analysis',
      'blended learning', 'workshop delivery',
    ],
    tickets: [],
    ticketMeans: 'No licence. Certification from a training body (CPD, ATD) is valued but not required.',
    supersedes: ['trainer'],
    notEqualTo: ['teacher', 'lecturer'],
    nearbyRoles: ['teacher'],
    notableFor: 'Often the easiest teaching-adjacent role to move into, since corporate employers do not require a teaching certificate.',
  },

  // ── Law enforcement ──────────────────────────────────────────────────────
  {
    id: 'police_officer',
    name: 'Police Officer',
    family: 'law_enforcement',
    definition:
      'Enforces law, responds to calls, investigates incidents, and holds arrest and use-of-force '
      + 'authority. Certified by the hiring agency.',
    signals: [
      'police officer', 'police constable', 'cop', 'law enforcement', 'patrol officer',
      'patrol', 'dispatcher police', 'use of force', 'arrest warrant', 'incumbent training',
      'entry level officer', 'reserve officer', 'police academy', 'de-escalation',
    ],
    tickets: ['peace_officer'],
    ticketMeans:
      'Agency certification following an academy. Applies only with that agency, and a '
      + 'background check including employment and criminal history is a hard gate.',
    supersedes: ['security_guard'],
    notEqualTo: ['security_guard', 'correction_officer'],
    nearbyRoles: ['correction_officer', 'firefighter'],
    notableFor: 'Certification follows the badge. Leaving the service generally ends the qualification.',
  },
  {
    id: 'detective',
    name: 'Detective',
    family: 'law_enforcement',
    definition:
      'Investigates serious crime: interviews, evidence, case building, and court preparation. '
      + 'Almost always reached by promotion rather than entry.',
    signals: [
      'detective', 'investigator', 'plainclothes', 'major crimes', 'homicide',
      'fraud unit', 'narcotics unit', 'interviewing', 'evidence collection', 'chain of custody',
      'case file', 'witness statement', 'surveillance', 'operational', 'covert',
    ],
    tickets: ['peace_officer'],
    ticketMeans: 'Almost always a senior patrol credential first. Agencies rarely hire investigators from outside.',
    supersedes: [],
    notEqualTo: ['private_investigator', 'police_officer'],
    nearbyRoles: ['police_officer'],
    notableFor: 'An internal promotion track. There is no external market for detectives without an existing service background.',
  },
  {
    id: 'correction_officer',
    name: 'Correctional Officer',
    family: 'corrections',
    definition:
      'Supervises incarcerated people: security, discipline, searches, and adherence to '
      + 'release conditions. Certified by the employing agency.',
    signals: [
      'correctional officer', 'corrections officer', 'prison officer', 'jail officer',
      'custody officer', 'inmate supervision', 'prison', 'jail', 'incarceration',
      'escort', 'searches', 'disciplinary', 'release planning', 'parole supervision',
    ],
    tickets: ['correction_officer'],
    ticketMeans: 'Agency certification, usually including physical fitness and a background check.',
    supersedes: ['prison guard'],
    notEqualTo: ['security_guard', 'police_officer'],
    nearbyRoles: ['police_officer', 'probation_officer'],
    notableFor: 'One of the largest public-sector employers in North America and a common second career after a first one.',
  },
  {
    id: 'probation_officer',
    name: 'Probation / Parole Officer',
    family: 'corrections',
    definition:
      'Supervises people in the community under court order: compliance, risk assessment, '
      + 'reporting, and preparing reports for the court.',
    signals: [
      'probation officer', 'parole officer', 'community supervision', 'caseload',
      'pretrial services', 'supervision officer', 'compliance', 'violation',
      'risk needs assessment', 'presentence report', 'court report', 'electronic monitoring',
      'community corrections',
    ],
    tickets: ['correction_officer'],
    ticketMeans: 'Agency certification plus a degree in criminal justice, social work or psychology is commonly required.',
    supersedes: [],
    notEqualTo: ['correction_officer', 'social_worker'],
    nearbyRoles: ['correction_officer', 'social_worker'],
    notableFor: 'The supervision role with the caseload rather than the prison population; caseload size varies enormously by jurisdiction.',
  },

  // ── Fire and rescue ──────────────────────────────────────────────────────
  {
    id: 'firefighter',
    name: 'Firefighter',
    family: 'fire_rescue',
    definition:
      'Responds to fire, medical emergencies and rescues: interior attack, ventilation, '
      + 'vehicle extrication, and patient care. A physically demanding certified profession.',
    signals: [
      'firefighter', 'fire fighter', 'fireman', 'fire service', 'fire rescue', 'engine company',
      'interior attack', 'ventilation', 'hoseline', 'forcible entry', 'ventilation entry',
      'search and rescue', 'extrication', 'jaws of life', 'structural firefighting',
      'wildland firefighting', 'hotshot', 'fire apparatus', 'pump operator',
    ],
    tickets: ['firefighter_cert'],
    ticketMeans:
      'International Fire Service Accreditation Congress certification, plus department '
      + 'specific training. The department decides entry standards, and hiring is per-department.',
    supersedes: ['fireman'],
    notEqualTo: ['ems', 'security_guard'],
    nearbyRoles: ['paramedic', 'police_officer'],
    notableFor: 'Physical fitness standards are the real gate; the certificate can be earned, but passing the fitness test decides employment.',
  },
  {
    id: 'wildland_firefighter',
    name: 'Wildland Firefighter',
    family: 'fire_rescue',
    definition:
      'Controls wildfire in rough terrain: fireline construction, hand tools, burnout and '
      + 'firing operations, often on long deployments far from home.',
    signals: [
      'wildland fire', 'wildfire', 'hotshot', 'fireline', 'hotshot crew', 'incident management team',
      'burnover', 'fire assignment', 'red flag warning', 'fuel model', 'brush clearing',
      'hand tool', 'pulaski', 'hotshot qualification', 'fire season', 'prescribed burn',
    ],
    tickets: ['firefighter_cert'],
    ticketMeans: 'National Wildfire Management Analyst or equivalent fitness qualification, plus a fitness standard.',
    supersedes: [],
    notEqualTo: ['firefighter'],
    nearbyRoles: ['firefighter'],
    notableFor:
      'Seasonal and itinerant — a distinct labour market from municipal firefighting, and the '
      + 'roster includes contract wildland crews.',
  },

  // ── Supervision and delivery ─────────────────────────────────────────────
  {
    id: 'site_supervisor',
    name: 'Site Supervisor',
    family: 'supervision',
    definition:
      'Runs a site or a section of one: the crew, the schedule, the safety performance, and '
      + 'the daily production target. The first step up from the trade.',
    signals: [
      'site supervisor', 'field supervisor', 'general supervisor', 'construction supervisor',
      'crewing', 'foreperson', 'working supervisor', 'site foreman', 'shift supervisor',
      'production supervisor', 'shift lead', 'crew leader', 'planning supervisor',
      'daily production report', 'dpr', 'toolbox talk delivery', 'smu', 'safety moment',
      'prestart', 'life saving rules',
    ],
    tickets: [],
    ticketMeans:
      'Usually no licence of its own — but it inherits the ticket of the trade it supervises, '
      + 'and employers often require the candidate to still hold one. First aid or a '
      + 'supervisory-level safety qualification is commonly added.',
    supersedes: ['working supervisor', 'shift lead'],
    notEqualTo: ['site_manager', 'project_manager'],
    nearbyRoles: ['site_manager', 'project_manager'],
    notableFor:
      'The most common progression out of a trade, and the first supervisory role on most FIFO sites.',
    fifo: true,
  },
  {
    id: 'site_manager',
    name: 'Site Manager',
    family: 'supervision',
    definition:
      'Accountable for a whole site: safety, production, people, budget, and the client '
      + 'relationship. Holds the authority to stop work.',
    signals: [
      'site manager', 'site management', 'site leadership', 'construction manager',
      'general manager site', 'deputy site manager', 'hsse manager', 'site director',
      'operations manager site', 'camp manager', 'site financial', 'site budget',
      'client representative', 'stop work authority',
    ],
    tickets: [],
    ticketMeans: 'No trade licence required, though the HSSE credential is often held. Significant site experience is the actual requirement.',
    supersedes: ['site supervisor'],
    notEqualTo: ['project_manager', 'operations_manager'],
    nearbyRoles: ['site_supervisor', 'project_manager'],
    notableFor: 'Holds stop-work authority — real accountability rather than a certificate.',
    fifo: true,
  },
  {
    id: 'project_manager',
    name: 'Project Manager',
    family: 'project_delivery',
    definition:
      'Owns delivery of a defined scope: schedule, cost, risk, quality and handover. '
      + 'Accountable to a client rather than to a site.',
    signals: [
      'project manager', 'project management', 'pmp', 'prince2', 'pmi', 'pmbok',
      'scope management', 'schedule management', 'critical path', 'gantt', 'earned value',
      'change order', 'variation order', 'risk register', 'milestone', 'handover',
      'pmp certification', 'prince2 practitioner', 'agile delivery', 'scrum master',
    ],
    tickets: [],
    ticketMeans: 'A project management qualification is expected but rarely mandatory. Site safety certification is usually required by contract instead.',
    supersedes: ['project coordinator'],
    notEqualTo: ['program_manager', 'site_manager'],
    nearbyRoles: ['site_manager', 'operations_manager'],
    notableFor: 'Distinguished from a site manager by accountability boundary: PM owns the scope, SM owns the place.',
  },
];

export default { PROFESSION_TITLES, PROFESSION_FAMILIES, CERTIFYING_BODY };
