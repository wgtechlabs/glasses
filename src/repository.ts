const REPOSITORY_PATTERN =
	/^(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;

/** Accepts only a GitHub owner/repository identifier, never a URL or ref. */
export function isValidRepository(value: string): boolean {
	if (!REPOSITORY_PATTERN.test(value)) return false;
	const repository = value.split("/")[1];
	return repository !== "." && repository !== "..";
}

export function assertRepository(value: string): string {
	if (!isValidRepository(value)) {
		throw new Error("Repository must be a strict owner/repository identifier.");
	}
	return value;
}

export function repositoryPath(repository: string): string {
	assertRepository(repository);
	return `/workspace/${repository.replace("/", "--")}`;
}
