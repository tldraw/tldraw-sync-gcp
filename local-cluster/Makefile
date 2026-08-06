CLUSTER_NAME := tldraw-local
KUBE_CONTEXT := k3d-$(CLUSTER_NAME)
KUBECTL      := kubectl --context $(KUBE_CONTEXT)
HELM         := helm --kube-context $(KUBE_CONTEXT)
# New tag per deploy so pods always roll onto the freshly imported image.
# ':=' (immediate) so build and helm --set see the SAME timestamp; still
# overridable from the command line: make deploy-aws IMAGE_TAG=mytag
IMAGE_TAG    := $(shell date +%Y%m%d%H%M%S)

.PHONY: cluster cluster-down

cluster: ## Create the k3d cluster with prometheus CRDs and ingress-nginx
	k3d cluster create --config k3d-config.yaml --wait
	helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update
	helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update
	helm repo update prometheus-community ingress-nginx
	$(HELM) upgrade --install prometheus-operator-crds prometheus-community/prometheus-operator-crds
	$(HELM) upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
		--namespace ingress-nginx --create-namespace \
		-f ingress-nginx-values.yaml --wait --timeout 5m

cluster-down: ## Delete the k3d cluster
	k3d cluster delete $(CLUSTER_NAME)
