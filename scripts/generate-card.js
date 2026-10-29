import { Resvg } from '@resvg/resvg-js';
import fs from 'fs';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="#ffffff"/>
  
  <g transform="translate(600, 315)">
    <!-- Header row: Icon + Yolk! Title -->
    <g transform="translate(-240, -45)">
      <circle cx="0" cy="0" r="56" fill="#FACC15" stroke="#000000" stroke-width="10"/>
      <text x="85" y="38" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="120" font-weight="900" fill="#000000" letter-spacing="-3">Yolk!</text>
    </g>
    <!-- Subtitle -->
    <text x="0" y="80" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="32" font-weight="500" fill="#71717a" letter-spacing="-0.5">Stream your music seamlessly without restrictions.</text>
  </g>
</svg>`;

const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: 1200 }
});
const pngData = resvg.render().asPng();
fs.writeFileSync('og-card.png', pngData);
console.log('og-card.png generated successfully, size:', pngData.length);
