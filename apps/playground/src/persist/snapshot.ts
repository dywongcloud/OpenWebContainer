/**
 * A copy of the container, kept in IndexedDB across reloads.
 *
 * The container runs in the page, so reloading the tab threw away everything a session had
 * built: the files an install wrote, the file open in the editor and the server that was
 * listening were gone, and the tab came back to the file system it boots with. This keeps the
 * container's own files and what the session had open, and puts them back on the next load.
 *
 * Text only: the container hands a file back as text through its worker, so a file whose bytes
 * are not text -- a wasm module, a native binding -- is not preserved byte for byte.
 */

const DB_NAME = "owc-playground-container";
const DB_VERSION = 1;
const FILE_STORE = "files";
const META_STORE = "meta";
const META_KEY = "session";
const SCOPE_KEY = "owc-playground-tab";

/**
 * Which tab's container this is. Every tab runs its own container, and a reload has to find the
 * one this tab had: a snapshot shared by origin hands a tab another tab's files and runs another
 * tab's command, and each tab's save then deletes what the other had written. A tab keeps its own
 * id in `sessionStorage`, which is per tab and survives the reload the copy exists for.
 */
function tabScope(): string {
	try {
		const existing = window.sessionStorage.getItem(SCOPE_KEY);
		if (existing) return existing;
		const created =
			typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
				? crypto.randomUUID()
				: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		window.sessionStorage.setItem(SCOPE_KEY, created);
		return created;
	} catch {
		return "single";
	}
}

/** A port that was listening, and the line the user ran to start it. */
export interface SnapshotServer {
	port: number;
	command: string;
}

export interface SnapshotMeta {
	openFile: string;
	servers: SnapshotServer[];
}

export interface SnapshotFile {
	path: string;
	text: string;
}

/**
 * Paths the container provides for itself. They are not the user's, they are thousands of files
 * no session ever wrote, and writing them back would only shadow the copies the container
 * already has.
 */
const PROVIDED_PREFIXES = ["/bin/", "/usr/", "/dev/", "/proc/", "/sys/", "/lib/", "/etc/", "/tmp/"];

export function isContainerFile(path: string): boolean {
	return path.startsWith("/") && !PROVIDED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

let opened: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
	if (!opened) {
		opened = new Promise((resolve, reject) => {
			const request = indexedDB.open(`${DB_NAME}-${tabScope()}`, DB_VERSION);
			request.onupgradeneeded = () => {
				const database = request.result;
				if (!database.objectStoreNames.contains(FILE_STORE)) {
					database.createObjectStore(FILE_STORE);
				}
				if (!database.objectStoreNames.contains(META_STORE)) {
					database.createObjectStore(META_STORE);
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}
	return opened;
}

function settled(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
}

function request<T>(idbRequest: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		idbRequest.onsuccess = () => resolve(idbRequest.result);
		idbRequest.onerror = () => reject(idbRequest.error);
	});
}

export async function writeFiles(files: SnapshotFile[]): Promise<void> {
	if (files.length === 0) return;
	const database = await openDb();
	const transaction = database.transaction(FILE_STORE, "readwrite");
	const store = transaction.objectStore(FILE_STORE);
	for (const file of files) {
		store.put(file.text, file.path);
	}
	await settled(transaction);
}

export async function deleteFiles(paths: string[]): Promise<void> {
	if (paths.length === 0) return;
	const database = await openDb();
	const transaction = database.transaction(FILE_STORE, "readwrite");
	const store = transaction.objectStore(FILE_STORE);
	for (const path of paths) {
		store.delete(path);
	}
	await settled(transaction);
}

/** The paths already stored, which is all a save pass needs to know what has been deleted. */
export async function readStoredPaths(): Promise<string[]> {
	const database = await openDb();
	const transaction = database.transaction(FILE_STORE, "readonly");
	const keys = await request(transaction.objectStore(FILE_STORE).getAllKeys());
	return keys.map((key) => String(key));
}

export async function readFiles(): Promise<SnapshotFile[]> {
	const database = await openDb();
	const transaction = database.transaction(FILE_STORE, "readonly");
	const store = transaction.objectStore(FILE_STORE);
	const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
	return keys.map((key, index) => ({ path: String(key), text: String(values[index] ?? "") }));
}

export async function writeMeta(meta: SnapshotMeta): Promise<void> {
	const database = await openDb();
	const transaction = database.transaction(META_STORE, "readwrite");
	transaction.objectStore(META_STORE).put(meta, META_KEY);
	await settled(transaction);
}

export async function readMeta(): Promise<SnapshotMeta | null> {
	try {
		const database = await openDb();
		const transaction = database.transaction(META_STORE, "readonly");
		const meta = await request<SnapshotMeta | undefined>(
			transaction.objectStore(META_STORE).get(META_KEY)
		);
		if (!meta || typeof meta !== "object") return null;
		return {
			openFile: typeof meta.openFile === "string" ? meta.openFile : "",
			servers: Array.isArray(meta.servers) ? meta.servers.filter((server) => server && Number.isInteger(server.port)) : []
		};
	} catch {
		return null;
	}
}
