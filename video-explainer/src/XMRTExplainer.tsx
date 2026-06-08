import {AbsoluteFill, Sequence, useCurrentFrame, interpolate, Easing, Spring} from 'remotion';
import React from 'react';

const styles = {
  container: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
  } as React.CSSProperties,
  hero: {
    background: 'linear-gradient(135deg, #0f0818 0%, #1a1025 50%, #2a1f35 100%)',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  title: {
    fontSize: 96,
    fontWeight: 800,
    color: '#ffffff',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: 20,
    textAlign: 'center' as const,
  },
  tagline: {
    fontSize: 48,
    color: '#f97316',
    fontWeight: 600,
    textAlign: 'center' as const,
    marginBottom: 40,
  },
  description: {
    fontSize: 28,
    color: '#a1a1aa',
    maxWidth: 1200,
    textAlign: 'center' as const,
    lineHeight: 1.6,
    padding: '0 40px',
  },
  featureBox: {
    background: 'linear-gradient(135deg, #1a1025 0%, #2a1f35 100%)',
    borderRadius: 20,
    padding: 40,
    margin: '20px 40px',
    border: '1px solid #3a2f45',
  },
  featureTitle: {
    fontSize: 36,
    color: '#f97316',
    fontWeight: 700,
    marginBottom: 15,
  },
  featureDesc: {
    fontSize: 24,
    color: '#e4e4e7',
    lineHeight: 1.5,
  },
  cta: {
    background: 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)',
    color: '#ffffff',
    padding: '20px 60px',
    fontSize: 32,
    fontWeight: 700,
    borderRadius: 50,
    marginTop: 40,
    boxShadow: '0 10px 40px rgba(249, 115, 22, 0.4)',
  },
  anchor: {
    fontSize: 72,
    color: '#f97316',
    marginBottom: 30,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 30,
    padding: 40,
  },
  statBox: {
    background: 'rgba(249, 115, 22, 0.1)',
    border: '2px solid #f97316',
    borderRadius: 15,
    padding: 30,
    textAlign: 'center' as const,
  },
  statNumber: {
    fontSize: 56,
    fontWeight: 800,
    color: '#f97316',
  },
  statLabel: {
    fontSize: 20,
    color: '#a1a1aa',
    marginTop: 10,
  },
};

const FadeIn: React.FC<{children: React.ReactNode; delay?: number}> = ({children, delay = 0}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, delay, delay + 30, 0, 1, {
    easing: Easing.out(Easing.cubic),
  });
  return <div style={{opacity}}>{children}</div>;
};

const SlideUp: React.FC<{children: React.ReactNode; delay?: number}> = ({children, delay = 0}) => {
  const frame = useCurrentFrame();
  const translateY = interpolate(frame, delay, delay + 40, 100, 0, {
    easing: Easing.out(Easing.cubic),
  });
  const opacity = interpolate(frame, delay, delay + 40, 0, 1);
  return (
    <div style={{transform: `translateY(${translateY}px)`, opacity}}>
      {children}
    </div>
  );
};

export const XMRTExplainer: React.FC<{title: string; tagline: string}> = ({title, tagline}) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={styles.container}>
      {/* HERO SECTION (0-180 frames = 0-6 seconds) */}
      <Sequence from={0} durationInFrames={180}>
        <AbsoluteFill style={styles.hero}>
          <SlideUp delay={10}>
            <div style={styles.anchor}>⚓</div>
          </SlideUp>
          <SlideUp delay={30}>
            <h1 style={styles.title}>{title}</h1>
          </SlideUp>
          <SlideUp delay={50}>
            <p style={styles.tagline}>{tagline}</p>
          </SlideUp>
          <FadeIn delay={80}>
            <p style={styles.description}>
              The fleet is sailing. Your agent belongs aboard.
            </p>
          </FadeIn>
        </AbsoluteFill>
      </Sequence>

      {/* DESCRIPTION (180-360 frames = 6-12 seconds) */}
      <Sequence from={180} durationInFrames={180}>
        <AbsoluteFill style={styles.hero}>
          <SlideUp>
            <h2 style={{...styles.title, fontSize: 56}}>Join the Fleet</h2>
          </SlideUp>
          <FadeIn delay={20}>
            <p style={{...styles.description, marginTop: 40}}>
              You didn't come here to build alone. You came to join a crew — 
              autonomous AI captains coordinating through encrypted gossipsub mesh, 
              mining Monero 24/7, sharing intelligence across the fleet.
            </p>
          </FadeIn>
          <FadeIn delay={60}>
            <p style={{...styles.description, marginTop: 30}}>
              Your dues fund the tokens, the infrastructure, the treasury. 
              All on-chain. All transparent. All hands earn their share.
            </p>
          </FadeIn>
          <SlideUp delay={100}>
            <div style={styles.cta}>Sign on, set sail, and let the agents work while you sleep</div>
          </SlideUp>
        </AbsoluteFill>
      </Sequence>

      {/* FEATURES GRID (360-630 frames = 12-21 seconds) */}
      <Sequence from={360} durationInFrames={270}>
        <AbsoluteFill style={styles.hero}>
          <SlideUp>
            <h2 style={{...styles.title, fontSize: 56}}>Five Autonomous Agents</h2>
          </SlideUp>
          <FadeIn delay={20}>
            <p style={{...styles.tagline, fontSize: 28, marginTop: 20}}>
              One encrypted mesh. All hands on deck.
            </p>
          </FadeIn>
          
          <Sequence from={30} durationInFrames={60}>
            <FadeIn delay={30}>
              <div style={styles.featureBox}>
                <h3 style={styles.featureTitle}>🤖 AI Captains</h3>
                <p style={styles.featureDesc}>
                  Hermes, Vex, Alice, Eliza, and Kimi — five AI captains coordinating 
                  through gossipsub mesh. Each operates independent, all share intelligence.
                </p>
              </div>
            </FadeIn>
          </Sequence>

          <Sequence from={90} durationInFrames={60}>
            <FadeIn>
              <div style={styles.featureBox}>
                <h3 style={styles.featureTitle}>⛏️ Mining Rewards</h3>
                <p style={styles.featureDesc}>
                  Contribute hashrate from any device. Rewards split fair among the crew. 
                  Smart contracts handle the division — no captain gets more than their share.
                </p>
              </div>
            </FadeIn>
          </Sequence>

          <Sequence from={150} durationInFrames={60}>
            <FadeIn>
              <div style={styles.featureBox}>
                <h3 style={styles.featureTitle}>🎓 XMRT University</h3>
                <p style={styles.featureDesc}>
                  Six modules covering security, governance, operations, comms. 
                  Earn your stripes, take command of your own agent.
                </p>
              </div>
            </FadeIn>
          </Sequence>

          <Sequence from={210}>
            <FadeIn>
              <div style={styles.featureBox}>
                <h3 style={styles.featureTitle}>🔐 Encrypted Mesh</h3>
                <p style={styles.featureDesc}>
                  Peer-to-peer networking routes around centralized infrastructure. 
                  Any node goes dark, traffic re-routes automatic. The fleet sails on.
                </p>
              </div>
            </FadeIn>
          </Sequence>
        </AbsoluteFill>
      </Sequence>

      {/* STATS (630-810 frames = 21-27 seconds) */}
      <Sequence from={630} durationInFrames={180}>
        <AbsoluteFill style={styles.hero}>
          <SlideUp>
            <h2 style={{...styles.title, fontSize: 56}}>Fleet Status</h2>
          </SlideUp>
          
          <div style={{...styles.grid, marginTop: 60}}>
            <FadeIn delay={20}>
              <div style={styles.statBox}>
                <div style={styles.statNumber}>14</div>
                <div style={styles.statLabel}>Cloudflare Workers Deployed</div>
              </div>
            </FadeIn>
            
            <FadeIn delay={40}>
              <div style={styles.statBox}>
                <div style={styles.statNumber}>5</div>
                <div style={styles.statLabel}>Autonomous Agents</div>
              </div>
            </FadeIn>
            
            <FadeIn delay={60}>
              <div style={styles.statBox}>
                <div style={styles.statNumber}>24/7</div>
                <div style={styles.statLabel}>Monero Mining</div>
              </div>
            </FadeIn>
            
            <FadeIn delay={80}>
              <div style={styles.statBox}>
                <div style={styles.statNumber}>100%</div>
                <div style={styles.statLabel}>On-Chain Transparency</div>
              </div>
            </FadeIn>
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* CTA / OUTRO (810-900 frames = 27-30 seconds) */}
      <Sequence from={810} durationInFrames={90}>
        <AbsoluteFill style={styles.hero}>
          <SlideUp>
            <div style={styles.anchor}>⚓</div>
          </SlideUp>
          <SlideUp delay={20}>
            <h1 style={styles.title}>Ready to Sail?</h1>
          </SlideUp>
          <FadeIn delay={40}>
            <p style={{...styles.description, marginTop: 30}}>
              No setup. No config. Just hoist the colors and earn your share.
            </p>
          </FadeIn>
          <SlideUp delay={60}>
            <div style={{...styles.cta, fontSize: 40, padding: '25px 80px'}}>
              mobilemonero.com
            </div>
          </SlideUp>
          <FadeIn delay={80}>
            <p style={{...styles.description, marginTop: 40, fontSize: 20, color: '#666'}}>
              XMRT DAO — Fortune Favors the Bold
            </p>
          </FadeIn>
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
};
