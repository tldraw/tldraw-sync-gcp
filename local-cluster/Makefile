CLUSTER_NAME := tldraw-local
KUBE_CONTEXT := k3d-$(CLUSTER_NAME)
KUBECTL      := kubectl --context $(KUBE_CONTEXT)
HELM         := helm --kube-context $(KUBE_CONTEXT)
# New tag per deploy so pods always roll onto the freshly imported image.
# ':=' (immediate) so build and helm --set see the SAME timestamp; still
# overridable from the command line: make deploy-aws IMAGE_TAG=mytag
IMAGE_TAG    := $(shell date +%Y%m%d%H%M%S)

.PHONY: cluster cluster-down monitoring build-aws deploy-aws build-gcp deploy-gcp

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

monitoring: ## Install Prometheus + Grafana (kube-prometheus-stack)
	$(HELM) upgrade --install monitoring prometheus-community/kube-prometheus-stack \
		--namespace monitoring --create-namespace \
		-f monitoring-values.yaml --wait --timeout 10m

build-aws: ## Build the AWS demo image and import it into the cluster
	docker build -t tldraw-sync-aws:$(IMAGE_TAG) ../tldraw-sync-aws
	k3d image import --cluster $(CLUSTER_NAME) tldraw-sync-aws:$(IMAGE_TAG)

deploy-aws: build-aws ## Build, import, and helm-upgrade the AWS demo
	$(HELM) upgrade --install tldraw-aws ../tldraw-sync-aws/chart \
		--namespace tldraw-aws --create-namespace \
		--set image.tag=$(IMAGE_TAG) --wait --timeout 5m

build-gcp: ## Build the GCP demo image and import it into the cluster
	docker build -t tldraw-sync-gcp:$(IMAGE_TAG) ../tldraw-sync-gcp
	k3d image import --cluster $(CLUSTER_NAME) tldraw-sync-gcp:$(IMAGE_TAG)

deploy-gcp: build-gcp ## Build, import, and helm-upgrade the GCP demo
	$(HELM) upgrade --install tldraw-gcp ../tldraw-sync-gcp/chart \
		--namespace tldraw-gcp --create-namespace \
		--set image.tag=$(IMAGE_TAG) --wait --timeout 5m
