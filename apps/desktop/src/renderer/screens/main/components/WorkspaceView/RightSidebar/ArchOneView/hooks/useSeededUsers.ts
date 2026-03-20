const noop = () => {};

export function useSeededUsers(_worktreePath: string | undefined) {
	return { data: undefined, isLoading: false, refetch: noop };
}
