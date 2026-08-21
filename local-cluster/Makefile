CLUSTER_NAME := tldraw-local
KUBE_CONTEXT := k3d-$(CLUSTER_NAME)
KUBECTL      := kubectl --context $(KUBE_CONTEXT)
HELM         := helm --kube-context $(KUBE_CONTEXT)
# New tag per deploy so pods always roll onto the freshly imported image.
# ':=' (immediate) so build and helm --set see the SAME timestamp; still
# overridable from the command line: make deploy-aws IMAGE_TAG=mytag
IMAGE_TAG    := $(shell date +%Y%m%d%H%M%S)
# AWS is reached through Envoy, not ingress-nginx. Override when port-forwarding.
AWS_URL      ?= http://localhost:8081
# Which store holds Room ownership and worker membership. "redis" also needs
# REDIS_ENABLED=true so the chart deploys one.
REGISTRY_BACKEND ?= s3
REDIS_ENABLED    ?= false

.PHONY: cluster cluster-down monitoring dashboard build-aws deploy-aws build-gcp deploy-gcp verify-aws verify-gcp drill-aws

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
	$(KUBECTL) apply -f dashboards/tldraw-scaling-dashboard.yaml

dashboard: ## Install/refresh the Grafana "tldraw scaling" dashboard
	$(KUBECTL) apply -f dashboards/tldraw-scaling-dashboard.yaml

build-aws: ## Build the AWS demo image and import it into the cluster
	docker build -t tldraw-sync-aws:$(IMAGE_TAG) ../tldraw-sync-aws
	k3d image import --cluster $(CLUSTER_NAME) tldraw-sync-aws:$(IMAGE_TAG)

deploy-aws: build-aws ## Build, import, and helm-upgrade the AWS demo
	# --set-string on the tag: it is all digits, and --set would hand Helm a
	# number, which re-renders as scientific notation and yields an invalid
	# image reference.
	$(HELM) upgrade --install tldraw-aws ../tldraw-sync-aws/chart \
		--namespace tldraw-aws --create-namespace \
		--set-string image.tag=$(IMAGE_TAG) \
		--set registry.backend=$(REGISTRY_BACKEND) \
		--set redis.enabled=$(REDIS_ENABLED) \
		--wait --timeout 5m

build-gcp: ## Build the GCP demo image and import it into the cluster
	docker build -t tldraw-sync-gcp:$(IMAGE_TAG) ../tldraw-sync-gcp
	k3d image import --cluster $(CLUSTER_NAME) tldraw-sync-gcp:$(IMAGE_TAG)

deploy-gcp: build-gcp ## Build, import, and helm-upgrade the GCP demo
	$(HELM) upgrade --install tldraw-gcp ../tldraw-sync-gcp/chart \
		--namespace tldraw-gcp --create-namespace \
		--set image.tag=$(IMAGE_TAG) --wait --timeout 5m

verify-aws: ## E2E sync verification for the AWS demo through the ingress
	./scripts/verify-aws.sh

verify-gcp: ## E2E sync verification for the GCP demo through the ingress
	./scripts/verify-gcp.sh

drill-aws: ## Scale drill for the AWS demo: 2->3->4->3->2, measuring what clients feel
	cd ../tldraw-sync-aws/tldraw-client && [ -d node_modules ] || npm install --no-audit --no-fund
	cd ../tldraw-sync-aws/tldraw-client && node scale-drill.mjs \
		--url $(AWS_URL) --rooms 24 --steps 3,4,3,2 \
		--json ../../local-cluster/drill-latest.json
