FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

# Install Ollama
USER root
RUN apt-get update \
	&& apt-get install --yes --no-install-recommends zstd \
	&& rm -rf /var/lib/apt/lists/*
RUN curl --fail --show-error --location --retry 5 --retry-all-errors \
	--retry-delay 2 https://ollama.com/install.sh | sh

# Install Deno for the vscode user
USER vscode
RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y
ENV DENO_DIR=/home/vscode/.deno
ENV PATH=/home/vscode/.deno/bin:${PATH}