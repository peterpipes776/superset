import { electronTrpc } from "renderer/lib/electron-trpc";

export function useGreptileScore(
	worktreePath: string | undefined,
	pollInterval: number,
) {
	const { data, isLoading, refetch } =
		electronTrpc.archOne.getGreptileScore.useQuery(
			{ worktreePath: worktreePath ?? "" },
			{
				enabled: !!worktreePath,
				refetchInterval: pollInterval,
			},
		);

	return { data, isLoading, refetch };
}

export function useFixStatus(worktreePath: string | undefined) {
	const { data } = electronTrpc.archOne.getFixStatus.useQuery(
		{ worktreePath: worktreePath ?? "" },
		{
			enabled: !!worktreePath,
			refetchInterval: 3_000,
		},
	);

	return { data };
}
