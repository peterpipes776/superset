export function LogViewer({ lines }: { lines: string[] }) {
	return (
		<pre className="p-2 text-xs font-mono bg-muted/30 rounded overflow-auto max-h-48">
			{lines.length > 0 ? lines.join("\n") : "No log output"}
		</pre>
	);
}
