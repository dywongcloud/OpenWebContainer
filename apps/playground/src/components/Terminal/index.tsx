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

			term.onKey(({ key, domEvent }) => {
				/* The key is named by the event, never by keyCode alone. A keyCode is shared between a
			   cursor key and a character on some layouts and in synthetic key events, and reading
			   40 as ArrowDown turns a `(` typed inside a quoted argument into a request to rewrite
			   the line, which truncates the command being typed and leaves its quoting unbalanced. */
			switch (domEvent.key) {
					case "ArrowUp":
						onCommandRef.current("\x1b[A");
						break;
					case "ArrowDown":
						onCommandRef.current("\x1b[B");
						break;
					case "Enter":
						onCommandRef.current("\r");
						break;
					case "Backspace":
						onCommandRef.current("\b");
						break;
				/* Ctrl-C interrupts and Ctrl-D ends input: without them a REPL cannot be interrupted
				   or left, because the guest only ever sees keystrokes. */
				case "c":
				case "C":
					if (domEvent.ctrlKey && !domEvent.altKey) {
						onCommandRef.current("\x03");
						break;
					}
					onCommandRef.current(domEvent.key);
					break;
				case "d":
				case "D":
					if (domEvent.ctrlKey && !domEvent.altKey) {
						onCommandRef.current("\x04");
						break;
					}
					onCommandRef.current(domEvent.key);
					break;
					default:
						if (!domEvent.ctrlKey && !domEvent.altKey && (domEvent.key.length === 1 || key.length === 1)) {
							onCommandRef.current(domEvent.key.length === 1 ? domEvent.key : key);
						}
						break;
				}
			});
			element.addEventListener("paste", handlePaste);
			term.attachCustomKeyEventHandler((arg) => {
				if ((arg.ctrlKey || arg.metaKey) && arg.code === "KeyV" && arg.type === "keydown") {
					navigator.clipboard.readText().then((text) => {
						onCommandRef.current(text);
					});
				}
				return true;
			});

			xtermRef.current = term;
			flushOutput();
		};

		const handlePaste = (event: ClipboardEvent) => {
			const text = event.clipboardData?.getData("text");
			if (text) {
				onCommandRef.current(text);
			}
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

		open();
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
			resizeObserver?.disconnect();
			window.removeEventListener("resize", safeFit);
			document.removeEventListener("visibilitychange", safeFit);
			element.removeEventListener("paste", handlePaste);
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
