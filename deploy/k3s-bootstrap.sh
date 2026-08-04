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

echo "==> waiting for the node to be Ready"
sudo k3s kubectl wait --for=condition=Ready node --all --timeout=180s

echo "==> applying namespace and network policy"
if [ -f "${SCRIPT_DIR}/k8s/namespace.yaml" ]; then
  sudo k3s kubectl apply -f "${SCRIPT_DIR}/k8s/namespace.yaml"
  sudo k3s kubectl apply -f "${SCRIPT_DIR}/k8s/networkpolicy.yaml"
else
  sudo k3s kubectl create namespace autogent --dry-run=client -o yaml | sudo k3s kubectl apply -f -
  echo "    (networkpolicy.yaml not found next to this script — apply it manually)"
fi

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
