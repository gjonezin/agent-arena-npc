FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.149.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

RUN groupadd --gid 10003 npc \
    && useradd --uid 10003 --gid 10003 --create-home --home-dir /home/npc npc \
    && mkdir -p /opt/npc /workspace \
    && chown -R npc:npc /opt/npc /workspace

# The whole persona set; NPC_NAME picks one at start. One image serves every
# codex character, the same way the pi and harness images already work.
COPY --chown=npc:npc personas /opt/npc/personas
COPY --chown=npc:npc deploy/codex/run.sh /opt/npc/run.sh
COPY --chown=npc:npc deploy/codex/tick.md /opt/npc/tick.md

USER 10003:10003
WORKDIR /workspace
ENV NPC_NAME=zella
ENTRYPOINT ["/opt/npc/run.sh"]
