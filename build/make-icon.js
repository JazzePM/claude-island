// Ritar appikonen (512 px PNG) med Electrons inbyggda canvas. Kör: npx electron build/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 600 });
  await win.loadURL('data:text/html,<canvas id=c width=512 height=512></canvas>');
  const url = await win.webContents.executeJavaScript(`(() => {
    const c = document.getElementById('c'), x = c.getContext('2d'), S = 512;
    // Svart rundad ruta med en svag ljus kant, som ön.
    x.fillStyle = '#000';
    x.beginPath(); x.roundRect(16, 16, S - 32, S - 32, 112); x.fill();
    x.strokeStyle = 'rgba(255,255,255,0.10)'; x.lineWidth = 6;
    x.beginPath(); x.roundRect(19, 19, S - 38, S - 38, 109); x.stroke();
    // Korallfärgad stjärna (samma form som i ön).
    x.save(); x.translate(S / 2, S / 2); x.scale(13, 13); x.translate(-12, -12);
    x.strokeStyle = '#d97757'; x.lineWidth = 2.5; x.lineCap = 'round';
    x.stroke(new Path2D('M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4'));
    x.restore();
    return c.toDataURL('image/png');
  })()`);
  fs.writeFileSync(path.join(__dirname, 'icon.png'), Buffer.from(url.split(',')[1], 'base64'));
  app.quit();
});
