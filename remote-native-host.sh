#!/bin/sh

self=$0
while [ -L "$self" ]; do
	link=$(readlink "$self") || exit 126
	case $link in
		/*) self=$link ;;
		*) self=$(dirname "$self")/$link ;;
	esac
done
package_dir=$(CDPATH= cd -P -- "$(dirname -- "$self")" && pwd) || {
	printf '%s\n' "Remote native Pi launcher could not resolve its installed package directory." >&2
	exit 126
}
bootstrap=$package_dir/src/runs/shared/remote-native-bootstrap.ts

case ${PI_SUBAGENT_PI_BINARY-} in
	"") pi_command=pi ;;
	/*) pi_command=$PI_SUBAGENT_PI_BINARY ;;
	*)
		printf '%s\n' "Remote native Pi launcher failed: PI_SUBAGENT_PI_BINARY must be an absolute path to the remote Pi executable." >&2
		exit 126
		;;
esac

exec "$pi_command" \
	--no-extensions \
	--no-skills \
	--no-prompt-templates \
	--no-context-files \
	--no-session \
	--mode rpc \
	--extension "$bootstrap"
