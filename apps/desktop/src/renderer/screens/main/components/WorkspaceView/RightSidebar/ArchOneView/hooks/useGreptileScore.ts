const noop = () => {};

export function useGreptileScore(
	_worktreePath: string | undefined,
	_pollInterval: number,
) {
	return { data: undefined, isLoading: false, refetch: noop };
}

export function useFixStatus(_worktreePath: string | undefined) {
	return { data: undefined };
}
