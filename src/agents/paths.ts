/**
 * Where a cloned repository lives inside a sandbox. Shared between agent
 * wrappers (to know what to `cd` into) and channels (to know what to pass
 * as `repositoryPath` when invoking an agent).
 */
export function repositoryPath(repository: string): string {
	const name = repository.split("/")[1] ?? repository;
	return `/workspace/${name}`;
}
