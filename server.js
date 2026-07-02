// Web entry point: run the proxy + GUI servers without Electron; open the GUI
// in a browser. (Electron uses electron-main.js instead — see `npm run electron`.)
const { createApp } = require('./src');

const app = createApp();
app.start();

function shutdown(signal) {
  console.log(`\n[logger] ${signal} received, closing...`);
  app.stop().then(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
