# Manual GCP Deployment Guide

This guide walks through deploying tldraw-sync to a new GCP project from scratch.

## Prerequisites

Install the following tools:

```bash
# Google Cloud CLI
brew install google-cloud-sdk

# Terraform
brew install terraform

# Helm
brew install helm

# kubectl (usually included with gcloud)
gcloud components install kubectl
gcloud components install gke-gcloud-auth-plugin
```

## Step 1: Create GCP Project

Create a new project in the [GCP Console](https://console.cloud.google.com/projectcreate) or via CLI:

```bash
export PROJECT_ID=your-project-id
gcloud projects create $PROJECT_ID
```

> **Note:** GCP project IDs are globally unique across all of Google Cloud. If your chosen ID is taken, add a unique suffix (e.g., `tldraw-sync-mycompany` or `tldraw-sync-12345`).

## Step 2: Authenticate and Set Project

```bash
# Authenticate your user account
gcloud auth login

# Set the active project
gcloud config set project $PROJECT_ID

# Get Application Default Credentials (required for Terraform)
gcloud auth application-default login

# Set the ADC quota project (required for Terraform to access GCS)
gcloud auth application-default set-quota-project $PROJECT_ID
```

## Step 3: Link Billing Account

Billing must be enabled before you can enable most GCP APIs:

```bash
# List available billing accounts
gcloud billing accounts list

# Link your billing account to the project
gcloud billing projects link $PROJECT_ID --billing-account=YOUR-BILLING-ACCOUNT-ID
```

> **Note:** Replace `YOUR-BILLING-ACCOUNT-ID` with your billing account ID (format: `XXXXXX-XXXXXX-XXXXXX`).

## Step 4: Enable Required APIs

```bash
gcloud services enable \
  compute.googleapis.com \
  container.googleapis.com \
  redis.googleapis.com \
  storage.googleapis.com \
  artifactregistry.googleapis.com \
  servicenetworking.googleapis.com \
  cloudresourcemanager.googleapis.com \
  iam.googleapis.com
```

## Step 5: Create Terraform State Bucket

GCS bucket names are globally unique, so we use the project ID as a prefix:

```bash
gcloud storage buckets create gs://${PROJECT_ID}-tf-state --location=EU
```

## Step 6: Configure Terraform Variables

Create `infra-terraform/gcp/resources/terraform.tfvars`:

```hcl
# Project configuration
project_id         = "your-project-id"
project_name       = "your-project-id"
project_number     = "123456789012"  # Find in GCP Console
region             = "europe-west1"
zone               = "europe-west1-b"
storage_location   = "EU"
common_resource_id = "tldraw-sync"

# Network configuration
subnets_list = [
  {
    name      = "public-subnet"
    cidr      = "10.40.0.0/16"
    region    = "europe-west1"
    allow_nat = true
    secondary_ip_range = [
      { range_name = "public-subnet-secondary-range", ip_cidr_range = "10.48.0.0/14" },
      { range_name = "public-subnet-secondary-range-2", ip_cidr_range = "10.52.0.0/20" }
    ]
  }
]

nat_external_ips = [
  {
    name        = "tldraw-sync-nat-ip"
    description = "NAT IP for tldraw-sync"
    region      = "europe-west1"
  }
]

# Workload Identity configuration
gke_workload_identity_service_account = {
  "tldraw-sync-sa" = {
    current_project_roles = [
      "roles/storage.objectAdmin",
      "roles/monitoring.metricWriter",
      "roles/logging.logWriter"
    ]
    k8s_namespace = "default"
  }
}
```

To find your project number:

```bash
gcloud projects describe $PROJECT_ID --format='value(projectNumber)'
```

## Step 7: Initialize and Apply Terraform

```bash
cd infra-terraform/gcp/resources

# Initialize with project-specific backend
terraform init -backend-config="bucket=${PROJECT_ID}-tf-state"

# Preview changes
terraform plan

# Apply (takes 10-15 minutes for GKE + Redis)
terraform apply
```

> **Note:** If `terraform apply` fails mid-way (e.g., due to auth token timeout), simply run `terraform apply` again. Terraform will resume from where it left off.

This creates:

- VPC network with subnets
- GKE cluster (private, regional)
- Memorystore Redis instance
- GCS bucket for room data
- Artifact Registry for Docker images
- Service accounts with Workload Identity

## Step 8: Get GKE Credentials

The cluster uses a private endpoint, so we connect via DNS:

```bash
gcloud container clusters get-credentials tldraw-sync-cluster \
  --region europe-west1 \
  --project $PROJECT_ID \
  --dns-endpoint

# Verify connection
kubectl get nodes
```

## Step 9: Install NGINX Ingress Controller

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.replicaCount=2 \
  --set controller.service.type=LoadBalancer
```

Wait for the external IP:

```bash
kubectl get svc -n ingress-nginx ingress-nginx-controller -w
```

## Step 10: Build and Push Docker Image

Configure Docker for Artifact Registry:

```bash
gcloud auth configure-docker europe-west1-docker.pkg.dev
```

Build for the correct platform (GKE uses linux/amd64):

```bash
cd /path/to/tldraw-sync-gcp

docker buildx build \
  --platform linux/amd64 \
  -t europe-west1-docker.pkg.dev/${PROJECT_ID}/tldraw-sync/tldraw-gcp:latest \
  --push .
```

## Step 11: Get Redis IP

```bash
export REDIS_IP=$(gcloud redis instances list \
  --region europe-west1 \
  --format='value(host)' \
  --filter='name~tldraw-sync')

echo "Redis IP: $REDIS_IP"
```

## Step 12: Deploy Kubernetes Resources

The manifests use environment variable placeholders. Deploy with `envsubst`:

```bash
# Set required variables
export PROJECT_ID=your-project-id
export REDIS_IP=10.x.x.x  # From step 10
export INGRESS_HOST=your-domain.com  # Or use IP for testing

# Apply manifests with variable substitution
envsubst < kubernetes/service-account.yaml | kubectl apply -f -
envsubst < kubernetes/deployment.yaml | kubectl apply -f -
envsubst < kubernetes/ingress.yaml | kubectl apply -f -
```

**Required environment variables:**

| Variable       | Description            | Example               |
| -------------- | ---------------------- | --------------------- |
| `PROJECT_ID`   | GCP project ID         | `tldraw-sync-test`    |
| `REDIS_IP`     | Memorystore Redis IP   | `10.189.23.244`       |
| `INGRESS_HOST` | Domain for the Ingress | `gcp-sync.tldraw.xyz` |

## Step 13: Verify Deployment

Check pods are running:

```bash
kubectl get pods
kubectl logs -l app=tldraw-sync --tail=20
```

Test the health endpoint:

```bash
EXTERNAL_IP=$(kubectl get svc -n ingress-nginx ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

curl -H "Host: gcp-sync.tldraw.xyz" http://$EXTERNAL_IP/api/health
# Should return: ok
```

## Step 14: Configure DNS (Optional)

Point your domain to the external IP:

```bash
echo "External IP: $EXTERNAL_IP"
```

Create an A record in your DNS provider pointing to this IP.

## Changing the Ingress Hostname

The hostname is set via the `INGRESS_HOST` environment variable. To change it:

```bash
export INGRESS_HOST=your-new-domain.com
envsubst < kubernetes/ingress.yaml | kubectl apply -f -
```

For IP-based access (testing without DNS), uncomment the default rule in `kubernetes/ingress.yaml`.

---

## Cleanup

To destroy all resources:

```bash
# Delete Kubernetes resources
kubectl delete -f kubernetes/

# Uninstall NGINX Ingress
helm uninstall ingress-nginx -n ingress-nginx

# Destroy Terraform resources
cd infra-terraform/gcp/resources
terraform destroy

# Delete state bucket (optional)
gcloud storage rm -r gs://${PROJECT_ID}-tf-state

# Delete project (optional)
gcloud projects delete $PROJECT_ID
```

---

## Troubleshooting

### Image Pull Errors

If pods show `ImagePullBackOff` or `ErrImagePull`:

1. **Platform mismatch**: Ensure you built with `--platform linux/amd64`
2. **Auth issues**: Run `gcloud auth configure-docker europe-west1-docker.pkg.dev`
3. **Image not found**: Verify the image exists in Artifact Registry

### Pods Pending

If pods stay in `Pending` state:

```bash
kubectl describe pod <pod-name>
```

Common causes:

- **Insufficient CPU/memory**: Cluster autoscaler will add nodes (wait 2-3 min)
- **Node taints**: New nodes initializing (wait 1-2 min)

### Cannot Connect to Cluster

If `kubectl` commands fail:

```bash
# Ensure gke-gcloud-auth-plugin is installed
gcloud components install gke-gcloud-auth-plugin

# Re-fetch credentials with DNS endpoint
gcloud container clusters get-credentials tldraw-sync-cluster \
  --region europe-west1 \
  --project $PROJECT_ID \
  --dns-endpoint
```

### Redis Connection Failed

Check pods can reach Redis:

```bash
kubectl run redis-test --rm -it --image=redis:alpine -- redis-cli -h $REDIS_IP ping
# Should return: PONG
```

If it fails, verify:

- Redis instance is in the same VPC
- Firewall rules allow internal traffic
