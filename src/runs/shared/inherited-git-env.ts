// Git's repository-local variables (`git rev-parse --local-env-vars`, the list Git itself
// clears when it enters a submodule) plus the indexed `git -c` pairs. Inherited from a
// parent started inside a Git hook or `git --git-dir`, they override a child's cwd and
// route its Git commands to the parent's repository.
const GIT_REPOSITORY_ENV = /^GIT_(ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|OBJECT_DIRECTORY|DIR|WORK_TREE|IMPLICIT_WORK_TREE|GRAFT_FILE|INDEX_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|PREFIX|SHALLOW_FILE|COMMON_DIR)$/i;

export function omitInheritedGitRepositoryEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !GIT_REPOSITORY_ENV.test(key)));
}
