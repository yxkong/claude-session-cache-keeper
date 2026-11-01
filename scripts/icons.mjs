import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'assets/icons');
const source = path.join(root, 'assets/brand/logo-master.png');
await fs.mkdir(out, { recursive: true });
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
for (const size of sizes) await sharp(source).resize(size, size, { fit: 'contain', background: '#00000000' }).png().toFile(path.join(out, `icon-${size}.png`));
await fs.copyFile(path.join(out, 'icon-32.png'), path.join(out, 'tray.png'));
await fs.copyFile(path.join(out, 'icon-64.png'), path.join(out, 'tray@2x.png'));
for (const [name,size] of [['tray-mac.png',18],['tray-mac@2x.png',36]]) {
  const padding=size/18;
  await sharp(path.join(root,'assets/brand/tray-master.png')).trim({background:'#00000000',threshold:1})
    .resize(size-padding*2,size-padding*2,{fit:'contain',background:'#00000000'})
    .extend({top:padding,bottom:padding,left:padding,right:padding,background:'#00000000'}).png().toFile(path.join(out,name));
}
await fs.writeFile(path.join(out, 'app.ico'), await pngToIco([16, 32, 48, 128, 256].map(n => path.join(out, `icon-${n}.png`))));
const chunks = [];
for (const [type, size] of [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]]) {
  const png = await fs.readFile(path.join(out, `icon-${size}.png`));
  const header = Buffer.alloc(8); header.write(type, 0, 4, 'ascii'); header.writeUInt32BE(png.length + 8, 4); chunks.push(header, png);
}
const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8 + chunks.reduce((n, b) => n + b.length, 0), 4);
await fs.writeFile(path.join(out, 'app.icns'), Buffer.concat([header, ...chunks]));
await fs.copyFile(path.join(out, 'icon-512.png'), path.join(root, 'plugin/.claude-plugin/icon.png'));
console.log('Generated PNG, ICO, ICNS and plugin icons.');
