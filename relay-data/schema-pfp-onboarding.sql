-- PFP Onboarding Design Schema — post-sale client intake pipeline
-- Triggered by Stripe webhook after deposit payment

CREATE TABLE IF NOT EXISTS pfp_onboardings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID REFERENCES pfp_bookings(id),
  stripe_session_id TEXT UNIQUE,
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  client_phone TEXT,
  event_name TEXT,
  event_type TEXT,
  event_date DATE,
  event_start_time TIME,
  event_end_time TIME,
  guest_count INTEGER,
  venue TEXT,
  address TEXT,
  package_type TEXT,
  hours INTEGER,
  total_fee NUMERIC(10,2),
  deposit_paid NUMERIC(10,2),
  status TEXT DEFAULT 'pending',
  -- 'pending' = link sent, awaiting client
  -- 'in_progress' = client is customizing
  -- 'design_complete' = client finished design
  -- 'approved' = admin approved
  -- 'completed' = event done
  onboarding_token TEXT UNIQUE,
  onboarding_link_sent BOOLEAN DEFAULT false,
  onboarding_link_sent_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pfp_onboarding_designs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id UUID NOT NULL REFERENCES pfp_onboardings(id) ON DELETE CASCADE,
  print_type TEXT DEFAULT 'classic-strip',
  -- 'classic-strip', 'postcard', 'double-strip'
  color_theme TEXT DEFAULT 'blush-pink',
  -- 'blush-pink', 'elegant-black', 'classic-gold', 'fresh-white',
  -- 'emerald-velvet', 'midnight-blue', 'matte-black', 'matte-white',
  -- 'gold-sequin', 'black-sequin', 'blue-sequin'
  backdrop_curtain TEXT,
  corner_ornaments TEXT,
  border_style TEXT,
  border_color TEXT,
  background_fill TEXT,
  background_design TEXT,
  accent_color TEXT,
  custom_message TEXT,
  print_size TEXT,
  preview_json JSONB DEFAULT '{}',
  design_locked BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pfp_onboarding_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id UUID NOT NULL REFERENCES pfp_onboardings(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  -- 'client', 'coordinator', 'system'
  message TEXT NOT NULL,
  is_fleet_synced BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
