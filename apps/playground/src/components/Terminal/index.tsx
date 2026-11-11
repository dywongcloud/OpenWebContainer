import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
	onCommand: (input: string) => Promise<void>;
	output: string[];
}

export default function Terminal({ onCommand, output }: TerminalProps) {
	const terminalRef = useRef<HTMLDivElement>(null);
	const xtermRef = useRef<XTerm>();
	const lastOutputLengthRef = useRef(0);
	const outputRef = useRef(output);
	const onCommandRef = useRef(onCommand);

	outputRef.current = output;
	onCommandRef.current = onCommand;

	useEffect(() => {
		const element = terminalRef.current;
		if (!element) return;

		let disposed = false;
		let term: XTerm | undefined;
		let fitAddon: FitAddon | undefined;
		let resizeObserver: ResizeObserver | undefined;
		let openTimer: ReturnType<typeof setTimeout> | undefined;

		// xterm only builds its renderer once the pane has been laid out; opening into a pane with no
		// size leaves _renderer unset, and the first fit or write then reads dimensions of undefined.
		const open = () => {
			if (disposed || term || !element) return;
			if (element.clientWidth === 0 || element.clientHeight === 0) return;

			term = new XTerm({
				cursorBlink: true,
				fontFamily: 'Menlo, Monaco, "Courier New", monospace',
				fontSize: 14,
				theme: {
					background: "#1e1e1e",
				},
				convertEol: true,
			});
			fitAddon = new FitAddon();
			term.loadAddon(fitAddon);
			term.open(element);
			fitAddon.fit();

			/* onData is the byte stream a real pty would receive: arrow keys, Tab, Home/End,
			   Ctrl+letter, Escape, Backspace and Enter all arrive as the sequences a prompt
			   library decodes. onKey's per-key switch silently dropped most of them. */
			term.onData((data) => {
				onCommandRef.current(data);
			});
			term.attachCustomKeyEventHandler((arg) => {
				if ((arg.ctrlKey || arg.metaKey) && arg.code === "KeyV" && arg.type === "keydown") {
					navigator.clipboard.readText().then((text) => {
						if (text) onCommandRef.current(text);
					});
					return false;
				}
				return true;
			});

			xtermRef.current = term;
			flushOutput();
		};


		const flushOutput = () => {
			if (!term) return;
			const pending = outputRef.current.slice(lastOutputLengthRef.current);
			lastOutputLengthRef.current = outputRef.current.length;
			pending.forEach((line) => {
				if (line.length > 0) {
					term?.write(line);
				}
			});
		};

		const safeFit = () => {
			if (!element || element.clientWidth === 0 || element.clientHeight === 0) return;
			if (!term) {
				open();
				return;
			}
			try {
				fitAddon?.fit();
			} catch {
				/* the pane is mid-layout; the observer fits it on the next change */
			}
		};

		/* xterm's Viewport defers a syncScrollArea to a timeout of its own. A terminal opened and
		   disposed inside one commit -- which is what a StrictMode double mount does -- leaves that
		   timeout to run against a RenderService whose renderer the dispose has cleared, and it
		   throws an uncaught TypeError on every load. Opening on a later turn instead means a mount
		   that is torn down in the same commit never opens a terminal at all, so nothing is left to
		   throw; a real mount opens one a tick later, which is also after the pane has been laid
		   out. A timer rather than a frame so a tab that is loading in the background opens too. */
		openTimer = setTimeout(open, 0);
		if (typeof ResizeObserver !== "undefined") {
			resizeObserver = new ResizeObserver(safeFit);
			resizeObserver.observe(element);
		}
		window.addEventListener("resize", safeFit);
		// The split is laid out on an animation frame, so a pane that had no size when it mounted
		// is given one when the tab is shown; fit again then.
		document.addEventListener("visibilitychange", safeFit);

		return () => {
			disposed = true;
			if (openTimer !== undefined) clearTimeout(openTimer);
			resizeObserver?.disconnect();
			window.removeEventListener("resize", safeFit);
			document.removeEventListener("visibilitychange", safeFit);
			xtermRef.current = undefined;
			term?.dispose();
		};
	}, []);

	useEffect(() => {
		if (!xtermRef.current) return;

		const newOutput = output.slice(lastOutputLengthRef.current);
		lastOutputLengthRef.current = output.length;

		newOutput.forEach((line) => {
			if (line.length > 0) {
				xtermRef.current?.write(line);
			}
		});
	}, [output]);

	return (
		<div className="h-full w-full bg-[#1e1e1e]">
			{/*
			 * The pane owns a minimum size instead of inheriting everything from the split: a tab
			 * that is not the visible one never gets the split laid out -- the layout runs on an
			 * animation frame, which a hidden tab is never given -- so a pane measured only by what
			 * its parent gave it is 0x0 there, and xterm never opens. The minimum is the split's own
			 * minimum, so a laid-out pane is unaffected.
			 */}
			<div
				ref={terminalRef}
				className="h-full w-full"
				style={{ minHeight: 150, minWidth: 200 }}
			/>
		</div>
	);
}
