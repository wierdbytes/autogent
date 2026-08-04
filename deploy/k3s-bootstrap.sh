#!/usr/bin/env bash
# Bootstrap a k3s substrate for autogent agents on a fresh VM (remote plan R5).
#
# Run ON THE VM (Ubuntu 22.04+ assumed):
#   curl -fsSL https://raw.githubusercontent.com/wierdbytes/autogent/main/deploy/k3s-bootstrap.sh | bash
# or copy this repo's deploy/ directory over and run ./k3s-bootstrap.sh.
#
# Afterwards, ON THE OWNER MACHINE, merge the kubeconfig (printed at the end)
# and name the context to match provider_config.kube_context, e.g.:
#   KUBECONFIG=~/.kube/config:./k3s.yaml kubectl config view --flatten > ~/.kube/config.new
#   mv ~/.kube/config.new ~/.kube/config
#   kubectl config rename-context default k3s-agents
#
# Moving to AKS later is exactly this file minus the k3s install: create the
# namespace and the NetworkPolicy, and point kube_context at the AKS context.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

if ! command -v k3s >/dev/null 2>&1; then
  echo "==> installing k3s (server, single node)"
  # Traefik is disabled: agents are dial-out only, nothing needs an ingress.
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -
else
  echo "==> k3s already installed, skipping"
fi

echo "==> waiting for the node to register"
# `kubectl wait` errors out when the resource does not exist yet, and right
# after `systemd start` the Node object has not been created — poll for
# registration first, then wait for readiness.
for _ in $(seq 1 90); do
  if sudo k3s kubectl get nodes --no-headers 2>/dev/null | grep -q .; then
    break
  fi
  sleep 2
done
if ! sudo k3s kubectl get nodes --no-headers 2>/dev/null | grep -q .; then
  echo "node never registered; inspect: journalctl -u k3s --no-pager | tail -50" >&2
  exit 1
fi
sudo k3s kubectl wait --for=condition=Ready node --all --timeout=180s

echo "==> applying namespace and network policy"
apply_manifest() { # $1 = filename under deploy/k8s/
  if [ -f "${SCRIPT_DIR}/k8s/$1" ]; then
    sudo k3s kubectl apply -f "${SCRIPT_DIR}/k8s/$1"
    return
  fi
  # curl | bash leaves no files next to the script — fetch from the repo.
  local url
  for branch in master main; do
    url="https://raw.githubusercontent.com/wierdbytes/autogent/${branch}/deploy/k8s/$1"
    if curl -fsSL "$url" | sudo k3s kubectl apply -f -; then
      return
    fi
  done
  echo "    could not fetch $1 — apply it manually from deploy/k8s/" >&2
}
apply_manifest namespace.yaml
apply_manifest networkpolicy.yaml

echo "==> local-path storage class (k3s default)"
sudo k3s kubectl get storageclass local-path -o name

PUBLIC_IP="$(curl -fs https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
echo
echo "Done. To control this cluster from the owner machine:"
echo "  1. copy /etc/rancher/k3s/k3s.yaml to the owner machine"
echo "  2. replace 127.0.0.1 with ${PUBLIC_IP} in it (and open 6443/tcp to your IP only)"
echo "  3. merge it into ~/.kube/config and rename the context (see header)"
echo
echo "provider_config for Buzz Desktop:"
echo '  { "kube_context": "k3s-agents", "namespace": "autogent",'
echo '    "image": "ghcr.io/wierdbytes/autogent@sha256:<digest>",'
echo '    "storage_class": "local-path", "storage_size": "2Gi",'
echo '    "inactivity_seconds": 7200 }'
