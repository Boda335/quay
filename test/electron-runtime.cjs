'use strict';

const { app } = require('electron');
const http = require('node:http');
const { safeFetch } = require('../electron/http-download.cjs');

app.whenReady().then(async () => {
  const server = http.createServer((_request, response) => response.end('electron network runtime verified'));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await safeFetch(`http://dualstack-electron.test:${server.address().port}/`, {
      allowPrivateAddresses: true,
      dnsLookup: async () => [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 }
      ]
    });
    const reader = response.body.getReader();
    const chunk = await reader.read();
    const body = new TextDecoder().decode(chunk.value);
    if (response.status !== 200 || body !== 'electron network runtime verified') throw new Error(`Unexpected Electron network response: HTTP ${response.status}.`);
    process.stdout.write(`${JSON.stringify({ electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, lookupIntegration: 'passed' })}\n`);
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    app.quit();
  }
});
