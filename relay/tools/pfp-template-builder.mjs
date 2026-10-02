/**
 * Party Favor Photo — Professional Template Builder
 * 
 * Generates print-ready 4x6 photo booth templates with:
 * - Full-bleed AI-generated background
 * - Two identical 2x6 strips side by side
 * - Rounded photo frame cutouts
 * - Professional typography
 * - Center cut line
 * 
 * Output: 1200x1800 PNG @ 300 DPI
 */

import sharp from 'sharp';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', 'pfp-outputs');

// ── Constants ─────────────────────────────────────────────
const CANVAS_W = 1200;  // 4 inches @ 300 DPI
const CANVAS_H = 1800;  // 6 inches @ 300 DPI
const STRIP_W = 600;    // 2 inches
const STRIP_H = 1800;   // 6 inches
const FRAME_PADDING = 30;
const CORNER_R = 20;    // rounded corner radius
const FRAME_GAP = 20;   // gap between photo frames
const MARGIN = 40;      // margin from strip edges
const TEXT_TOP = 30;    // minimal top margin
const BOTTOM_AREA = 480; // bottom area for event details + design

// ── Style Configurations ──────────────────────────────────
const STYLES = {
  'elegant': {
    name: 'Elegant',
    textColor: '#DAA520',
    frameBorder: '#DAA520',
    accent: '#FFD700',
    font: 'Georgia, Palatino Linotype, serif',
  },
  'modern': {
    name: 'Modern',
    textColor: '#333333',
    frameBorder: '#CCCCCC',
    accent: '#666666',
    font: 'Helvetica Neue, Arial, sans-serif',
  },
  'classic': {
    name: 'Classic',
    textColor: '#1a1a2e',
    frameBorder: '#1a1a2e',
    accent: '#333333',
    font: 'Georgia, Palatino Linotype, serif',
  },
};

// ── SVG Helpers ───────────────────────────────────────────

function createCutLine() {
  // Vertical dashed cut line down the center
  const cx = CANVAS_W / 2;
  return `<line x1="${cx}" y1="0" x2="${cx}" y2="${CANVAS_H}" 
    stroke="#888" stroke-width="2" stroke-dasharray="8,6" opacity="0.6"/>`;
}

function createPhotoFrames(count, style) {
  var frames = '';
  var frameW = 520, frameH = 390, gap = 16, startY = 35;
  for (var i = 0; i < count; i++) {
    var y = startY + i * (frameH + gap);
    frames += '<rect x="' + MARGIN + '" y="' + y + '" width="' + frameW + '" height="' + frameH + '" rx="' + CORNER_R + '" ry="' + CORNER_R + '" fill="white" opacity="0.95" stroke="' + style.frameBorder + '" stroke-width="2.5"/>\n';
    frames += '<rect x="' + (MARGIN+2) + '" y="' + (y+2) + '" width="' + (frameW-4) + '" height="' + (frameH-4) + '" rx="' + (CORNER_R-1) + '" ry="' + (CORNER_R-1) + '" fill="none" stroke="rgba(0,0,0,0.08)" stroke-width="1"/>\n';
  }
  return frames;
}

function createBottomPanel(eventName, eventDate, style) {
  var ys = STRIP_H - BOTTOM_AREA;
  var tc = style.textColor;
  var fn = style.font;
  var acc = style.accent;
  var s = '';
  // Top decorative divider
  s += '<line x1="' + (MARGIN+10) + '" y1="' + (ys+15) + '" x2="' + (STRIP_W-MARGIN-10) + '" y2="' + (ys+15) + '" stroke="' + tc + '" stroke-width="1" opacity="0.35"/>\n';
  // Diamond accent on divider
  s += '<rect x="' + (Math.round(STRIP_W/2)-5) + '" y="' + (ys+10) + '" width="10" height="10" rx="2" ry="2" fill="' + tc + '" opacity="0.5" transform="rotate(45,' + (STRIP_W/2) + ',' + (ys+15) + ')"/>\n';
  
  // Event name - LARGE, prominent, filling the space
  s += '<text x="' + (STRIP_W/2) + '" y="' + (ys+75) + '" text-anchor="middle" fill="' + tc + '" font-family="' + fn + '" font-size="44" font-weight="bold" letter-spacing="4">' + escapeXml(eventName) + '</text>\n';
  
  // Event date
  if (eventDate) {
    s += '<text x="' + (STRIP_W/2) + '" y="' + (ys+115) + '" text-anchor="middle" fill="' + tc + '" font-family="' + fn + '" font-size="20" opacity="0.9" letter-spacing="3">' + escapeXml(eventDate) + '</text>\n';
  }
  
  // Bottom decorative divider
  s += '<line x1="' + (MARGIN+30) + '" y1="' + (ys+145) + '" x2="' + (STRIP_W-MARGIN-30) + '" y2="' + (ys+145) + '" stroke="' + tc + '" stroke-width="0.5" opacity="0.25"/>\n';
  
  // Branding: "Party Favor Photo" at bottom
  s += '<text x="' + (STRIP_W/2) + '" y="' + (ys+410) + '" text-anchor="middle" fill="' + tc + '" font-family="' + fn + '" font-size="11" opacity="0.3" letter-spacing="2">partyfavorphoto.com</text>\n';
  
  // Decorative scatter - spread across entire bottom area
  var stars = [];
  for (var i = 0; i < 25; i++) {
    var x = 20 + Math.floor(Math.random() * (STRIP_W - 40));
    var y = ys + 160 + Math.floor(Math.random() * 230);
    var r = 1 + Math.floor(Math.random() * 4);
    var op = 0.15 + Math.random() * 0.3;
    stars.push('<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + acc + '" opacity="' + op + '"/>');
  }
  s += stars.join('\n');
  return s;
}

function createDecorations(style) {
  // Simple decorative elements - stars/sparkles
  const decos = [];
  const positions = [
    [100, 120], [500, 100], [300, 80],
    [100, 300], [500, 280], [50, 500],
    [550, 520], [200, 700], [400, 680],
    [150, 900], [450, 880], [80, 1100],
    [520, 1120], [200, 1300], [400, 1280],
    [100, 1500], [500, 1480], [300, 1600],
    [120, 1700], [480, 1720],
  ];
  
  positions.forEach(([x, y]) => {
    const size = 3 + Math.random() * 4;
    const opacity = 0.3 + Math.random() * 0.4;
    decos.push(`<circle cx="${x}" cy="${y}" r="${size}" fill="${style.accent}" opacity="${opacity}"/>`);
  });
  
  return decos.join('\n');
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Main Builder ──────────────────────────────────────────

export async function buildTemplate({
  eventName = 'Class of 2026',
  eventDate = '',
  style = 'elegant',
  photoCount = 3,
  referenceImage = null, // URL to client invitation/flyer to match
  backgroundImage = null,
  backgroundPrompt = null,
  muapiKey = null,
} = {}) {
  
  const styleConfig = STYLES[style] || STYLES['gold-glitter'];
  
  // Ensure output dir
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  
  let bgBuffer = null;
  
  // Use reference image (invitation/flyer) as background if provided
  if (referenceImage) {
    try {
      const resp = await fetch(referenceImage);
      if (resp.ok) {
        bgBuffer = Buffer.from(await resp.arrayBuffer());
        console.log(`[PFP Template] Using reference image: ${referenceImage}`);
      }
    } catch (e) {
      console.log(`[PFP Template] Failed to fetch reference: ${e.message}`);
    }
  }
  
  // Generate background via MuAPI if prompt provided
  if (backgroundPrompt && backgroundPrompt.trim() && muapiKey) {
    console.log(`[PFP Template] Generating background via MuAPI: ${backgroundPrompt}`);
    const genResult = await fetch('https://api.muapi.ai/api/v1/nano-banana-2', {
      method: 'POST',
      headers: {
        'x-api-key': muapiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: backgroundPrompt,
        aspect_ratio: '2:3',
      }),
    });
    const genData = await genResult.json();
    
    if (genData.request_id) {
      // Poll for completion
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const pollResult = await fetch(
          `https://api.muapi.ai/api/v1/predictions/${genData.request_id}/result`,
          { headers: { 'x-api-key': muapiKey } }
        );
        const pollData = await pollResult.json();
        if (pollData.status === 'completed' && pollData.outputs?.[0]) {
          const imgResp = await fetch(pollData.outputs[0]);
          bgBuffer = Buffer.from(await imgResp.arrayBuffer());
          console.log(`[PFP Template] Background generated: ${pollData.outputs[0]}`);
          break;
        }
        if (pollData.status === 'failed') break;
      }
    }
  }
  
  // If no background from AI, create gradient background
  if (!bgBuffer) {
    console.log('[PFP Template] Creating fallback background');
    // Clean neutral background - real clients will provide reference images
    const svgGradient = `<svg width="${CANVAS_W}" height="${CANVAS_H}">
      <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="#FAFAFA"/>
      <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="#F5F0EB" opacity="0.5"/>
    </svg>`;
    bgBuffer = await sharp(Buffer.from(svgGradient)).png().toBuffer();
  } else {
    // Resize background to fill canvas exactly
    bgBuffer = await sharp(bgBuffer).resize(CANVAS_W, CANVAS_H, { fit: 'cover' }).png().toBuffer();
  }
  
  // Build left strip SVG
  const leftStripSVG = `<svg width="${STRIP_W}" height="${STRIP_H}">
    ${createPhotoFrames(photoCount, styleConfig)}
    ${createBottomPanel(eventName, eventDate, styleConfig)}
  </svg>`;
  
  const leftStrip = await sharp(Buffer.from(leftStripSVG))
    .png()
    .toBuffer();
  
  // Left strip is the first 600px, right strip is identical (duplicate)
  // Compose: background + left strip at x=0 + right strip at x=600 + cut line
  const cutLineSVG = `<svg width="${CANVAS_W}" height="${CANVAS_H}">
    ${createCutLine()}
  </svg>`;
  const cutLine = await sharp(Buffer.from(cutLineSVG)).png().toBuffer();
  
  // Composite everything
  const result = await sharp(bgBuffer)
    .composite([
      { input: leftStrip, top: 0, left: 0 },
      { input: leftStrip, top: 0, left: STRIP_W }, // duplicate strip
      { input: cutLine, top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
  
  // Save output
  const timestamp = Date.now();
  const filename = `pfp-template-${timestamp}.png`;
  const filepath = join(OUTPUT_DIR, filename);
  writeFileSync(filepath, result);
  
  console.log(`[PFP Template] Saved: ${filepath} (${(result.length / 1024).toFixed(1)} KB)`);
  
  return {
    filepath,
    filename,
    buffer: result,
    dimensions: `${CANVAS_W}x${CANVAS_H}`,
    size_kb: (result.length / 1024).toFixed(1),
  };
}

// ── CLI Usage ────────────────────────────────────────────
// Run directly: node pfp-template-builder.mjs
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const [k, v] = process.argv[i].split('=');
    args[k.replace('--', '')] = v || true;
  }
  
  const muapiKey = process.env.MUAPI_API_KEY;
  
  buildTemplate({
    eventName: args.name || 'Class of 2026',
    eventDate: args.date || 'June 12, 2026',
    style: args.style || 'elegant',
    photoCount: parseInt(args.frames) || 3,
    referenceImage: args.reference || args.ref || null,
    backgroundPrompt: args.prompt || null,
    muapiKey: muapiKey,
  }).then(r => {
    console.log(`\n✅ Template generated: ${r.filepath}`);
    console.log(`   Size: ${r.dimensions}, ${r.size_kb} KB`);
  }).catch(e => {
    console.error('Error:', e.message);
  });
}
