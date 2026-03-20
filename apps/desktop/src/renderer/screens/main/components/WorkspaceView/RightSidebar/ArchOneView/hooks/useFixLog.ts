import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

export function useFixLog(
	worktreePath: string | undefined,
	isActive: boolean,
) {
	const [lines, setLines] = useState<string[]>([]);
	const subscribed = useRef(false);

	electronTrpc.archOne.streamFixLog.useSubscription(
		{ worktreePath: worktreePath ?? "" },
		{
			enabled: !!worktreePath && isActive && !subscribed.current,
			onData: (event) => {
				if (event.type === "reset") {
					setLines([]);
				} else if (event.type === "data") {
					setLines((prev) => [...prev, ...event.data.split("\n")]);
				}
			},
		},
	);

	useEffect(() => {
		if (!isActive) {
			setLines([]);
		}
	}, [isActive]);

	return { lines };
}
