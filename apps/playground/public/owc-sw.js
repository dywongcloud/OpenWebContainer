/*
 * OpenWebContainer preview gateway (service worker).
 *
 * HTTP ingress only. A browser cannot provide raw TCP or UDP sockets to the outside,
 * so the container's virtual TCP/UDP stays inside the container. This worker takes a
 * request for /__owc/preview/<port>/<path> and hands it to a window client (the page
 * that owns the container). That page forwards it through the worker bridge to the
 * HTTP server listening on <port>; the response comes back here and is answered to
 * the browser. Request and response bodies cross the message channel as base64.
 */

const PREVIEW_PATH_PREFIX = '/__owc/preview/';
const PREVIEW_PATTERN = /^\/__owc\/preview\/(\d+)(\/.*)?$/;
const REQUEST_MESSAGE = 'owc-preview-request';
const REQUEST_TIMEOUT_MS = 25000;
const CLIENT_POLL_MS = 250;
const NULL_BODY_STATUSES = [204, 205, 304];
const DROPPED_RESPONSE_HEADERS = ['connection', 'keep-alive', 'transfer-encoding', 'content-length'];

class GatewayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith(PREVIEW_PATH_PREFIX)) {
    event.respondWith(handlePreview(event.request, url));
    return;
  }
  event.respondWith(fetch(event.request));
});

async function handlePreview(request, url) {
  const match = PREVIEW_PATTERN.exec(url.pathname);
  if (!match) {
    return textResponse(404, 'Not a preview path.');
  }
  const port = Number(match[1]);
  if (port < 1 || port > 65535) {
    return textResponse(400, 'Invalid preview port.');
  }
  const path = (match[2] || '/') + url.search;
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;

  try {
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const body = hasBody ? bytesToBase64(new Uint8Array(await request.arrayBuffer())) : null;
    const client = await findClient(deadline);
    const reply = await askClient(client, {
      id: self.crypto.randomUUID(),
      port,
      method: request.method,
      path,
      headers: headersToObject(request.headers),
      body,
    }, deadline);
    return responseFromReply(reply, port);
  } catch (error) {
    if (error instanceof GatewayError) {
      return textResponse(error.status, error.message);
    }
    return textResponse(502, 'Preview failed: ' + (error && error.message ? error.message : String(error)));
  }
}

// Prefer a focused window; otherwise any window of this origin. Wait for one to appear
// until the deadline, so a page that is reloading still gets the request.
async function findClient(deadline) {
  for (;;) {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length > 0) {
      return clients.find((client) => client.focused) || clients[0];
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new GatewayError(504, 'No OpenWebContainer page is open to serve this preview.');
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(CLIENT_POLL_MS, remaining)));
  }
}

function askClient(client, message, deadline) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.onmessage = null;
      reject(new GatewayError(504, 'Preview request timed out after ' + REQUEST_TIMEOUT_MS + ' ms.'));
    }, Math.max(0, deadline - Date.now()));

    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      const data = event.data || {};
      if (data.error) {
        reject(new GatewayError(502, 'Preview handler failed: ' + data.error));
      } else {
        resolve(data);
      }
    };

    try {
      client.postMessage({ type: REQUEST_MESSAGE, ...message }, [channel.port2]);
    } catch (error) {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      reject(new GatewayError(502, 'The preview page did not accept the request.'));
    }
  });
}

function responseFromReply(reply, port) {
  const status = Number(reply.status);
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new GatewayError(502, 'Preview handler returned an invalid status.');
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(reply.headers || {})) {
    const key = name.toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.includes(key)) {
      continue;
    }
    headers.set(key, String(value));
  }
  // Absolute-path redirects must stay inside the gateway prefix.
  const location = headers.get('location');
  if (location && location.startsWith('/') && !location.startsWith('//')) {
    headers.set('location', '/__owc/preview/' + port + location);
  }
  // Preview output changes between runs; never let the browser keep it.
  headers.set('cache-control', 'no-store');

  const bytes = reply.body ? base64ToBytes(reply.body) : new Uint8Array(0);
  const body = NULL_BODY_STATUSES.includes(status) ? null : bytes;
  return new Response(body, {
    status,
    statusText: String(reply.statusText || '').replace(/[^\x20-\x7e]/g, '').trim(),
    headers,
  });
}

function textResponse(status, message) {
  return new Response(message + '\n', {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function headersToObject(headers) {
  const out = {};
  headers.forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
