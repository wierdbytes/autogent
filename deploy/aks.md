az provider register --namespace Microsoft.ContainerService
az group create --name autogent-rg --location swedencentral
az aks create \
     --resource-group autogent-rg \
     --name autogent-aks \
     --location swedencentral \
     --node-count 1 \
     --node-vm-size Standard_B2s_v2 \
     --network-plugin azure \
     --network-policy azure \
     --generate-ssh-keys

az aks get-credentials --resource-group autogent-rg --name autogent-aks
kubectl --context autogent-aks apply -f deploy/k8s/namespace.yaml
kubectl --context autogent-aks apply -f deploy/k8s/networkpolicy.yaml

 и в provider_config агента в Buzz Desktop:
 ```jsonc
   {
     "kube_context": "autogent-aks",
     "namespace": "autogent",
     "image": "ghcr.io/wierdbytes/autogent:latest",
     "storage_class": "managed-csi",
     "storage_size": "2Gi",
     "inactivity_seconds": 7200
   }
 ```
