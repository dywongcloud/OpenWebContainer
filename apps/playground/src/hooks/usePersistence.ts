import { useEffect, useRef } from "react";
import type { ContainerManager } from "@open-web-container/api";
import {
	deleteFiles,
	isContainerFile,
	readFiles,
	readMeta,
	readStoredPaths,
	writeFiles,
	writeMeta,
	type SnapshotMeta,
	type SnapshotServer
} from "../persist/snapshot";

/*
 * How much of the tree one pass copies, and how often a pass runs. A pass reads that many files
 * and walks the whole tree once to find them, because the container runs on one thread -- the
 * same thread the command in the terminal is using -- and a pass that read everything an install
 * wrote would take the thread for seconds at a time. Cycling through the tree instead copies all
 * of it eventually and never takes the thread for long.
 */
const FILES_PER_PASS = 120;
const SAVE_INTERVAL_MS = 2000;
/** A file this size is not worth the copy: the biggest installs are full of bundles this big. */
const MAX_FILE_CHARS = 2_000_000;
/*
 * The container answers a listing on the one thread its commands run on, and a command that is
 * using that thread leaves a listing nothing to answer on: a pass that waited for one forever
 * waited forever, and a session that started a server early saved nothing from then on. A pass
 * that gets no answer drops itself and the next one tries again.
 */
const LIST_TIMEOUT_MS = 5000;
const READ_TIMEOUT_MS = 2000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		work,
		new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), ms);
		})
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

interface Options {
	containerReady: boolean;
	container: ContainerManager | null;
	openFile: string;
	servers: SnapshotServer[];
	onRestored: (meta: SnapshotMeta) => void;
}

/**
 * Puts the container back the way the last load left it, and keeps it that way.
 *
 * Restore runs once, as soon as the container answers: the directories first, so a file written
 * into one is not written into nothing, then the files, then what the session had open. Saving
 * runs in the background for as long as the tab is open, and once more when the tab goes away.
 */
export function usePersistence({ containerReady, container, openFile, servers, onRestored }: Options) {
	const openFileRef = useRef(openFile);
	openFileRef.current = openFile;
	const serversRef = useRef(servers);
	serversRef.current = servers;
	const onRestoredRef = useRef(onRestored);
	onRestoredRef.current = onRestored;
	const restoringRef = useRef(false);

	useEffect(() => {
		if (!containerReady || !container || restoringRef.current) return;
		restoringRef.current = true;

		/*
		 * The restore is not abandoned when the effect is torn down. React runs an effect, tears
		 * it down and runs it again before the first await comes back, so an effect that stopped
		 * its own restore on teardown restored nothing at all, and the second run found the mark
		 * the first had left and never started.
		 */
		(async () => {
			const [files, meta] = await Promise.all([readFiles(), readMeta()]);
			if (!container) return;

			const directories = new Set<string>();
			for (const file of files) {
				let directory = file.path.slice(0, Math.max(0, file.path.lastIndexOf("/")));
				while (directory.length > 1 && !directories.has(directory)) {
					directories.add(directory);
					directory = directory.slice(0, Math.max(0, directory.lastIndexOf("/")));
				}
			}
			for (const directory of [...directories].sort((left, right) => left.length - right.length)) {
				try {
					await container.createDirectory(directory);
				} catch {
					/* the container already has it */
				}
			}
			for (const file of files) {
				try {
					await container.writeFile(file.path, file.text);
				} catch {
					/* a path the container will not take back */
				}
			}
			if (meta) onRestoredRef.current(meta);
		})();
	}, [containerReady, container]);

	useEffect(() => {
		if (!containerReady || !container) return;
		let stopped = false;
		let cursor = 0;
		let running = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const pass = async () => {
			if (running) return;
			running = true;
			try {
				const listed = await withTimeout(container!.listFiles("/"), LIST_TIMEOUT_MS);
				if (!listed) return;
				const paths = listed.filter(isContainerFile).sort();
				const stored = new Set(await readStoredPaths());
				const gone = [...stored].filter((path) => !paths.includes(path));
				if (gone.length > 0) {
					await deleteFiles(gone);
				}
				if (paths.length > 0) {
					const batch = [];
					for (let index = 0; index < FILES_PER_PASS && index < paths.length; index++) {
						const path = paths[(cursor + index) % paths.length];
						const text = await withTimeout(container!.readFile(path), READ_TIMEOUT_MS);
						if (text === undefined || text.length > MAX_FILE_CHARS) continue;
						batch.push({ path, text });
					}
					cursor = (cursor + FILES_PER_PASS) % paths.length;
					await writeFiles(batch);
				}
				await writeMeta({ openFile: openFileRef.current, servers: serversRef.current });
			} catch {
				/* the container was busy; the next pass tries again */
			} finally {
				running = false;
			}
		};

		const tick = async () => {
			await pass();
			if (!stopped) timer = setTimeout(tick, SAVE_INTERVAL_MS);
		};

		const onHide = () => {
			void pass();
		};

		void tick();
		window.addEventListener("pagehide", onHide);

		return () => {
			stopped = true;
			window.removeEventListener("pagehide", onHide);
			if (timer !== undefined) clearTimeout(timer);
		};
	}, [containerReady, container]);
}
