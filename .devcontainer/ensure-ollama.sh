#!/bin/bash
# Ensures the Ollama server is running and the cloud models this project uses
# are available. Intended to be invoked as the dev container's postStartCommand.
#
# Logs:
#   /tmp/ollama.log      - ollama serve output
#   /tmp/ollama-pull.log - pull output / failures

HOST=127.0.0.1:11434
MODELS=(glm-5.3-flash:cloud glm-5.3:cloud)

ensure_ollama_home() {
	if [[ -d "$HOME/.ollama" ]]; then
		sudo chown -R "$(id -u):$(id -g)" "$HOME/.ollama"
	fi
}

start_server() {
	if pgrep -x ollama >/dev/null; then
		return 0
	fi
	nohup ollama serve >/tmp/ollama.log 2>&1 &
}

# Wait until the server answers, so we never pull against a dead endpoint.
wait_for_server() {
	local attempt
	for attempt in $(seq 1 30); do
		if curl -fsS "http://$HOST/api/version" >/dev/null 2>&1; then
			return 0
		fi
		sleep 0.5
		ensure_ollama_home
	done
	return 1
}

# Cloud models require an authenticated account; a missing key surfaces here.
pull_model() {
	local model="$1"
	if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$model"; then
		return 0
	fi
	if ! ollama pull "$model" >>/tmp/ollama-pull.log 2>&1; then
		echo "$(date -Is) failed to pull $model" >>/tmp/ollama-pull.log
		echo "run 'ollama signin', then 'ollama pull $model'" >>/tmp/ollama-pull.log
		return 1
	fi
}

start_server

missing=0
if wait_for_server; then
	for model in "${MODELS[@]}"; do
		if ! pull_model "$model"; then
			missing=1
		fi
	done
else
	echo "ollama server did not come up at $HOST" >>/tmp/ollama-pull.log
	missing=1
fi

exit $missing