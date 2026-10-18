#!/bin/sh
# This host-specific synthetic-demo cutover preserves the old daemon data root.
set -eu
cd /home/ecs-user/alert-triage-demo
umask 077
sudo docker image inspect chaitin/agent-compose:sha-70bfd0b >/dev/null
daemon_auth=$(awk -F= '$1=="AGENT_COMPOSE_AUTH_TOKEN" {print $2}' .env)
if [ -z "$daemon_auth" ]; then daemon_auth=$(openssl rand -hex 32); fi
env_next=$(mktemp .env.deploy.XXXXXX)
awk -F= '$1!="AGENT_COMPOSE_IMAGE" && $1!="AGENT_COMPOSE_GUEST_IMAGE" && $1!="AGENT_COMPOSE_DATA_DIR" && $1!="AGENT_COMPOSE_AUTH_TOKEN" && $1!="OCTOBUS_IMAGE"' .env > "$env_next"
{
  printf '\nAGENT_COMPOSE_IMAGE=chaitin/agent-compose:sha-70bfd0b\n'
  printf 'AGENT_COMPOSE_GUEST_IMAGE=chaitin/agent-compose-guest:sha-70bfd0b\n'
  printf 'AGENT_COMPOSE_DATA_DIR=./agent-compose-data-70bfd0b\n'
  printf 'OCTOBUS_IMAGE=ghcr.io/chaitin/octobus@sha256:377409360a3d54f8e058340a7fb4874a994f18d11d35ba8f7cae0bec23a724a6\n'
  printf 'AGENT_COMPOSE_AUTH_TOKEN=%s\n' "$daemon_auth"
} >> "$env_next"
chmod 600 "$env_next"
mv "$env_next" .env
mkdir -p logs
sudo chmod 700 agent-compose-data-70bfd0b
# Exact project container only; never remove its data directory or Docker volumes.
if sudo docker container inspect alert-triage-agent-compose >/dev/null 2>&1; then
  sudo docker logs alert-triage-agent-compose > logs/agent-compose-before-cutover.log 2>&1
  sudo docker stop alert-triage-agent-compose >/dev/null
  sudo docker rm alert-triage-agent-compose >/dev/null
fi
sudo docker-compose -f docker-compose.yml -f docker-compose.cloud.yml up -d --no-deps agent-compose
for attempt in 1 2 3 4 5; do
  if sudo docker exec alert-triage-agent-compose /app/agent-compose status >/dev/null 2>&1; then break; fi
  sleep 1
done
node scripts/configure-gateway.mjs
sudo docker exec alert-triage-agent-compose /app/agent-compose -f /data/work/agent-compose.yml up
sudo docker exec alert-triage-agent-compose /app/agent-compose scheduler ls triage
