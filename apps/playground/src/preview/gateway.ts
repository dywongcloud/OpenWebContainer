/**
 * Page side of the preview gateway.
 *
 * public/owc-sw.js answers /__owc/preview/<port>/<path> by posting an
 * 'owc-preview-request' message to this page. startPreviewGateway hands the request
 * to the app's handler (which forwards it through the container's worker bridge) and
 * returns the response over the MessagePort that the service worker supplied.
 *
 * HTTP ingress only. A browser cannot provide raw TCP or UDP sockets, so the
 * container's virtual TCP/UDP stays inside the container. Bodies are carried as latin1
 * byte strings -- one character per byte -- so the HTTP bridge keeps every byte.
 */

const PREVIEW_PREFIX = '/__owc/preview';
const SERVICE_WORKER_URL = '/owc-sw.js';
const REQUEST_MESSAGE = 'owc-preview-request';
const PORTS_MESSAGE = 'owc-preview-ports';
const TAB_PARAM = '__owc-tab';
const TAB_SCOPE_KEY = 'owc-playground-tab';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
/** How often a page tells the worker what it serves, whether or not its ports have changed. */
const ADVERTISE_INTERVAL_MS = 5000;

/**
 * Ports this page's container is serving. The service worker routes a preview by port,
 * so a page that never says what it is serving may never be asked, and a stale entry
 * would keep sending requests to a server that has gone away.
 */
let advertisedPorts: number[] = [];

/**
 * Which tab this page is.
 *
 * A navigation reaches the service worker with no client id of its own, so a preview opened by a
 * link cannot be routed back to the tab the link came from by the request alone. sessionStorage is
 * per tab and survives a reload, so it names this tab inside the URL the link carries; the worker
 * strips it again before the guest server sees the request. It is the same key the snapshot uses,
 * so one tab has one name for both.
 */
function tabId(): string {
	try {
		const existing = window.sessionStorage.getItem(TAB_SCOPE_KEY);
		if (existing) return existing;
		const created =
			typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
				? crypto.randomUUID()
				: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		window.sessionStorage.setItem(TAB_SCOPE_KEY, created);
		return created;
	} catch {
		return "";
	}
}

function advertisePorts(): void {
	const controller = navigator.serviceWorker && navigator.serviceWorker.controller;
	if (!controller) return;
	try {
		controller.postMessage({ type: PORTS_MESSAGE, ports: advertisedPorts, tab: tabId() });
	} catch {
		/* the worker is not ready; the next advertisement will reach it */
	}
}

let previewPortsSink: ((ports: number[]) => void) | null = null;

/** Tell the gateway which ports this page's container serves, so previews are routed here. */
export function setPreviewPorts(ports: number[]): void {
	if (previewPortsSink) previewPortsSink(ports);
}

export interface PreviewRequest {
	method: string;
	/** Path plus query as the guest server sees it, for example "/hello?x=1". */
	path: string;
	headers: Record<string, string>;
	/** Request body as a latin1 byte string (one character per byte), or undefined. */
	body: string | undefined;
}

export type PreviewHandler = (port: number, request: PreviewRequest) => Promise<Response>;

interface PreviewMessage {
	type: typeof REQUEST_MESSAGE;
	id: string;
	port: number;
	method: string;
	path: string;
	headers: Record<string, string>;
	body: string | null;
}

// Module-level so repeated starts (for example React StrictMode effects) share one listener.
let activeHandler: PreviewHandler | null = null;
let listening = false;
let controllerBound = false;

/** Browser URL for a server inside the container, for example previewUrl(3070, "/hello"). */
export function previewUrl(port: number, path: string = "/"): string {
	const suffix = path === "" || path.startsWith("/") ? path : `/${path}`;
	const [beforeQuery, existingQuery] = suffix.split("?");
	const tab = tabId();
	const query = [tab ? `${TAB_PARAM}=${encodeURIComponent(tab)}` : "", existingQuery || ""]
		.filter((part) => part.length > 0)
		.join("&");
	return `${PREVIEW_PREFIX}/${port}${beforeQuery}${query ? `?${query}` : ""}`;
}

/**
 * Registers the preview service worker and routes its requests to `handle`.
 * Resolves to a stop function, or null when this browser cannot run the gateway.
 */
export async function startPreviewGateway(handle: PreviewHandler): Promise<(() => void) | null> {
	activeHandler = handle;
	const stop = () => {
		if (activeHandler === handle) {
			activeHandler = null;
		}
		setPreviewPorts([]);
	};

	/** Tell the gateway which ports this page's container serves, so previews are routed here. */
	function setPreviewPorts(ports: number[]): void {
		const next = Array.from(new Set(ports.filter((port) => Number.isInteger(port)))).sort((a, b) => a - b);
		if (next.length === advertisedPorts.length && next.every((port, index) => port === advertisedPorts[index])) {
			return;
		}
		advertisedPorts = next;
		advertisePorts();
	}
	previewPortsSink = setPreviewPorts;

	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
		console.warn("[preview] Service workers are not supported here; the preview gateway is disabled.");
		return null;
	}
	if (!window.isSecureContext && !LOCAL_HOSTS.includes(location.hostname)) {
		console.warn("[preview] The preview gateway needs https or localhost; it is disabled on this origin.");
		return null;
	}

	if (!listening) {
		navigator.serviceWorker.addEventListener("message", onWorkerMessage);
		listening = true;
	}

	try {
		await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" });
	} catch (error) {
		console.warn("[preview] Service worker registration failed.", error);
		stop();
		return null;
	}
	// Say what this page serves, and say it again if the worker is replaced.
	advertisePorts();
	if (!controllerBound) {
		navigator.serviceWorker.addEventListener("controllerchange", advertisePorts);
		controllerBound = true;
	}
	/* A worker the browser has stopped and started again has forgotten what every page serves,
	   and a page only spoke when its ports changed, so from that moment the gateway routed by
	   guesswork until a server happened to start or stop. Saying it again on a timer costs one
	   message and puts the map back. */
	const heartbeat = setInterval(advertisePorts, ADVERTISE_INTERVAL_MS);
	const stopAll = () => {
		clearInterval(heartbeat);
		stop();
	};
	return stopAll;
}

async function onWorkerMessage(event: MessageEvent): Promise<void> {
	const message = event.data as PreviewMessage | undefined;
	if (!message || message.type !== REQUEST_MESSAGE) {
		return;
	}
	const reply = event.ports[0];
	if (!reply) {
		return;
	}

	const handler = activeHandler;
	if (!handler) {
		reply.postMessage({ error: "The preview gateway is not running in this page." });
		return;
	}

	try {
		/* A service worker cannot read the Cookie request header; the page's own jar is
		   the only place it survives, so put it back before the guest server sees it. */
		const requestHeaders: Record<string, string> = { ...message.headers };
		if (!Object.keys(requestHeaders).some((name) => name.toLowerCase() === 'cookie') && document.cookie) {
			requestHeaders.cookie = document.cookie;
		}
		const response = await handler(message.port, {
			method: message.method,
			path: message.path,
			headers: requestHeaders,
			body: message.body === null ? undefined : decodeBase64ToBinary(message.body),
		});
		/* Chrome drops Set-Cookie from a Response built by a service worker. The core
		   bridge carries it as x-owc-set-cookie; apply it here, where document.cookie
		   is available, and keep the internal header out of the preview response. */
		const setCookie = response.headers.get('x-owc-set-cookie');
		if (setCookie) {
			try {
				for (const value of JSON.parse(setCookie) as string[]) document.cookie = value;
			} catch {
				/* a value the bridge could not encode is left alone */
			}
		}
		const headers: Record<string, string> = {};
		response.headers.forEach((value, name) => {
			if (name.toLowerCase() === 'x-owc-set-cookie') return;
			headers[name] = value;
		});
		const bytes = new Uint8Array(await response.arrayBuffer());
		reply.postMessage({
			status: response.status,
			statusText: response.statusText,
			headers,
			body: encodeBytesToBase64(bytes),
		});
	} catch (error) {
		reply.postMessage({ error: error instanceof Error ? error.message : String(error) });
	}
}

function decodeBase64ToBinary(text: string): string {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	let out = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return out;
}

function encodeBytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}
