// Renders the PNG icons and social images from public/icons/icon.svg.
// Run: node scripts/render-icons.cjs (needs Playwright with Chromium).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "public", "icons");
const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
// Maskable: full-bleed square; the church and post shrink into the central safe zone.
const maskable = svg.replace(/rx="112"/g, 'rx="0"').replace('<g id="landmarks">', '<g id="landmarks" transform="translate(46 56) scale(.82)">');
const font = "font-family:'Segoe UI',Roboto,'DejaVu Sans',system-ui,sans-serif";
const sized = (s, w, h = w) => s.replace("<svg ", `<svg style="width:${w}px;height:${h}px;display:block" `);

// Round avatar for Telegram (it crops to a circle) and other profiles.
const avatar = `<div style="width:512px;height:512px;border-radius:50%;overflow:hidden;position:relative">
  ${sized(maskable, 512)}
  <div style="position:absolute;left:0;right:0;top:330px;text-align:center;color:#fff;${font};text-shadow:0 2px 10px rgba(0,0,0,.35)">
    <div style="font-size:60px;font-weight:800;letter-spacing:.5px;line-height:1">DONYATT</div>
    <div style="font-size:38px;font-weight:700;letter-spacing:6px;margin-top:8px">FLOOD WATCH</div>
  </div></div>`;

// Link preview card (1200x630), shown when the site is shared.
const card = `<div style="width:1200px;height:630px;background:linear-gradient(135deg,#0a2f47,#0f5a7d);display:flex;align-items:center;gap:56px;padding:0 90px;box-sizing:border-box;${font};color:#fff">
  ${sized(svg, 300)}
  <div><div style="font-size:76px;font-weight:800;line-height:1.02">Donyatt<br>Flood Watch</div>
  <div style="font-size:34px;margin-top:22px;opacity:.9">Live River Isle flooding status<br>for the A358 south of Donyatt</div></div></div>`;

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const shot = async (name, html, w, h = w) => {
    await p.setViewportSize({ width: w, height: h });
    await p.setContent(`<style>html,body{margin:0;background:transparent}</style>${html}`);
    await p.screenshot({ path: path.join(dir, name), omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  };
  await shot("icon-192.png", sized(svg, 192), 192);
  await shot("icon-512.png", sized(svg, 512), 512);
  await shot("maskable-512.png", sized(maskable, 512), 512);
  await shot("apple-touch-icon.png", sized(maskable, 180), 180);
  await shot("favicon-32.png", sized(svg, 32), 32);
  await shot("avatar-512.png", avatar, 512);
  await shot("social-card.png", card, 1200, 630);
  await b.close();
})();
