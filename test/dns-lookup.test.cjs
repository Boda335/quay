'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const {
  safeFetch, resolveTarget, createPinnedLookup, isPrivateAddress
} = require('../electron/http-download.cjs');

const address = (ip) => ({ address: ip, family: ip.includes(':') ? 6 : 4 });

function requestStub(redirectByHost, onRequest = () => {}) {
  return (_transport, url, options) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = (error) => request.emit('error', error);
    request.end = () => {
      options.lookup(url.hostname, { all: true }, (error, addresses) => {
        if (error) { request.emit('error', error); return; }
        onRequest(url.hostname, addresses);
        setImmediate(() => {
          const response = new EventEmitter();
          const location = redirectByHost[url.hostname];
          response.statusCode = location ? 302 : 200;
          response.statusMessage = location ? 'Found' : 'OK';
          response.headers = location ? { location } : {};
          response.setTimeout = () => {};
          request.emit('response', response);
        });
      });
    };
    return request;
  };
}

async function main() {
  const pinned = createPinnedLookup([address('8.8.8.8'), address('2606:4700:4700::1111')]);
  await new Promise((resolve, reject) => pinned('fixture.test', (error, ip, family) => {
    try { assert.ifError(error); assert.equal(ip, '8.8.8.8'); assert.equal(family, 4); resolve(); } catch (failure) { reject(failure); }
  }));
  await new Promise((resolve, reject) => pinned('fixture.test', { all: true }, (error, ips) => {
    try { assert.ifError(error); assert.deepEqual(ips, [address('8.8.8.8'), address('2606:4700:4700::1111')]); resolve(); } catch (failure) { reject(failure); }
  }));
  await new Promise((resolve, reject) => pinned('fixture.test', 6, (error, ip, family) => {
    try { assert.ifError(error); assert.equal(ip, '2606:4700:4700::1111'); assert.equal(family, 6); resolve(); } catch (failure) { reject(failure); }
  }));
  await new Promise((resolve, reject) => pinned('fixture.test', { family: 6 }, (error, ip, family) => {
    try { assert.ifError(error); assert.equal(ip, '2606:4700:4700::1111'); assert.equal(family, 6); resolve(); } catch (failure) { reject(failure); }
  }));
  await new Promise((resolve) => createPinnedLookup([{ address: undefined, family: 4 }])('bad.test', { all: true }, (error, ips) => {
    assert.ok(error);
    assert.equal(ips, undefined);
    resolve();
  }));

  const resolverFailure = Object.assign(new Error('mock DNS failure'), { code: 'EAI_AGAIN' });
  await assert.rejects(resolveTarget(new URL('https://dns-failure.test'), false, async () => { throw resolverFailure; }), (error) => error === resolverFailure);
  await assert.rejects(resolveTarget(new URL('https://empty.test'), false, async () => []), /no IP addresses/);
  await assert.rejects(resolveTarget(new URL('https://invalid.test'), false, async () => [{ address: undefined, family: 4 }]), /valid IP address/);
  await assert.rejects(resolveTarget(new URL('https://mixed.test'), false, async () => [address('8.8.8.8'), address('10.1.2.3')]), { code: 'SECURITY_BLOCKED' });
  assert.equal((await resolveTarget(new URL('https://ipv4.test'), false, async () => [address('1.1.1.1')]))[0].family, 4);
  assert.equal((await resolveTarget(new URL('https://ipv6.test'), false, async () => [address('2606:4700:4700::1111')]))[0].family, 6);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('2001:db8::1'), true);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);

  let safeRedirectRequests = 0;
  const publicDns = async (host) => ({
    'first-public.test': [address('8.8.8.8')],
    'second-public.test': [address('1.1.1.1')],
    'private-target.test': [address('192.168.1.4')]
  })[host] || [];
  const redirected = await safeFetch('http://first-public.test/start', {
    method: 'HEAD', dnsLookup: publicDns,
    requestImpl: requestStub({ 'first-public.test': 'http://second-public.test/final' }, (_host, ips) => {
      safeRedirectRequests++;
      assert.ok(ips[0].family === 4 && ips[0].address);
    })
  });
  assert.equal(redirected.status, 200);
  assert.equal(safeRedirectRequests, 2);

  let privateRedirectRequests = 0;
  await assert.rejects(safeFetch('http://first-public.test/start', {
    method: 'HEAD', dnsLookup: publicDns,
    requestImpl: requestStub({ 'first-public.test': 'http://private-target.test/internal' }, () => { privateRedirectRequests++; })
  }), { code: 'SECURITY_BLOCKED' });
  assert.equal(privateRedirectRequests, 1, 'private redirect must be rejected before connecting');

  const server = http.createServer((_request, response) => response.end('node address selection works'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await safeFetch(`http://dualstack.test:${server.address().port}/`, {
      allowPrivateAddresses: true,
      dnsLookup: async () => [address('::1'), address('127.0.0.1')]
    });
    assert.equal(response.status, 200);
    await response.body.cancel();
  } finally { await new Promise((resolve) => server.close(resolve)); }

  console.log('DNS lookup tests passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
