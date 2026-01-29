# GCP Products Used in tldraw-sync-gcp

This document lists all Google Cloud Platform products and services used in this project.

## Summary

| Product                        | Purpose                              |
| ------------------------------ | ------------------------------------ |
| Google Kubernetes Engine (GKE) | Container orchestration              |
| Google Cloud Storage (GCS)     | Room snapshots and asset persistence |
| Cloud Memorystore for Redis    | Distributed locking and pub/sub      |
| Artifact Registry              | Docker image registry                |
| Virtual Private Cloud (VPC)    | Network infrastructure               |
| Cloud Compute (Networking)     | Router, NAT, Firewall, Global IPs    |
| IAM & Service Accounts         | Authentication and authorization     |
| Cloud DNS                      | Domain management                    |
| Resource Manager               | Project-level resource management    |
| Workload Identity              | Keyless authentication for CI/CD     |

---

## 1. Google Kubernetes Engine (GKE)

**Purpose:** Production container orchestration platform

**Configuration:**

- Regional cluster with autoscaling (1-20 nodes)
- Machine type: e2-medium
- Horizontal Pod Autoscaler (CPU/Memory at 70% threshold)
- Workload Identity enabled

**Files:**

- `infra-terraform/gcp/resources/gke.tf`
- `infra-terraform/modules/gke_cluster/cluster.tf`
- `kubernetes/deployment.yaml`
- `kubernetes/service-account.yaml`

**Terraform Resource:** `google_container_cluster`

---

## 2. Google Cloud Storage (GCS)

**Purpose:** Persistence layer for room snapshots and uploaded assets

**Configuration:**

- Bucket name: `tldraw-sync-room-data`
- Storage class: STANDARD
- Lifecycle rule: 30-day auto-delete
- Stores room snapshots as JSON in `rooms/{roomId}`
- Stores assets in `uploads/{uploadId}`

**Files:**

- `src/gcsStorage.ts`
- `infra-terraform/gcp/resources/storage_buckets.tf`
- `infra-terraform/modules/storage_bucket/bucket.tf`

**NPM Package:** `@google-cloud/storage` v7.17.3

**Terraform Resource:** `google_storage_bucket`

---

## 3. Cloud Memorystore for Redis

**Purpose:** Distributed locking for room ownership and pub/sub for room handover coordination

**Configuration:**

- Instance name: `tldraw-sync-redis`
- Memory size: 5 GB
- Redis version: REDIS_6_X
- Persistence: RDB snapshots every 1 hour
- High availability with replica
- Location: europe-west1-b / europe-west1-c

**Usage:**

- Lock key format: `lock:room:{roomId}` (10-second TTL)
- Handover channels: `room-handover`, `handover-lock-released:{roomId}`, `handover-ready:{roomId}`

**Files:**

- `src/roomManager.ts`
- `infra-terraform/gcp/resources/memorystore.tf`
- `infra-terraform/modules/memorystore/main.tf`

**NPM Package:** `redis` v5.9.0

**Terraform Resource:** `google_redis_instance`

---

## 4. Artifact Registry

**Purpose:** Docker container image registry

**Configuration:**

- Repository ID: `tldraw-sync`
- Format: DOCKER
- Location: europe-west1
- Image path: `europe-west1-docker.pkg.dev/{project-id}/tldraw-sync/tldraw-gcp:{tag}`

**Files:**

- `infra-terraform/gcp/resources/artifact-registry.tf`
- `infra-terraform/modules/artifact_registry/main.tf`
- `.github/workflows/deploy.yaml`

**Terraform Resource:** `google_artifact_registry_repository`

---

## 5. Virtual Private Cloud (VPC)

**Purpose:** Network infrastructure for GKE and Redis connectivity

**Configuration:**

- VPC network with custom subnets
- Secondary IP ranges for pods and services
- Private Service Connect enabled

**Files:**

- `infra-terraform/gcp/resources/network.tf`
- `infra-terraform/modules/core_network/network.tf`

**Terraform Resources:** `google_compute_network`, `google_compute_subnetwork`

---

## 6. Cloud Compute (Networking Components)

**Purpose:** Network routing, NAT, and firewall management

**Components:**

- Cloud Router for egress traffic
- Cloud NAT for outbound connectivity
- Firewall rules for ingress/egress control
- Global IP addresses for VPC peering

**Files:**

- `infra-terraform/modules/core_network/firewall_*.tf`
- `infra-terraform/modules/firewall_rules/main.tf`

**Terraform Resources:** `google_compute_router`, `google_compute_router_nat`, `google_compute_firewall`, `google_compute_address`, `google_compute_global_address`

---

## 7. IAM & Service Accounts

**Purpose:** Authentication and authorization for GKE workloads

**Service Accounts:**

- `tf-gke` - GKE node pool service account
- `tldraw-sync-sa` - Workload Identity service account

**Roles Assigned:**

- `roles/artifactregistry.reader` - Pull images from Artifact Registry
- `roles/container.defaultNodeServiceAccount` - GKE default permissions
- `roles/iam.workloadIdentityUser` - K8s to GCP SA binding
- `roles/iam.serviceAccountTokenCreator` - Token generation

**Files:**

- `infra-terraform/gcp/resources/iam.tf`
- `infra-terraform/modules/service_accounts/main.tf`
- `kubernetes/service-account.yaml`

**Terraform Resources:** `google_service_account`, `google_service_account_iam_member`, `google_project_iam_member`

---

## 8. Cloud DNS

**Purpose:** Managed DNS zones for domain resolution

**Configuration:**

- Public and private managed zones
- Domain: `gcp-sync.tldraw.xyz`

**Files:**

- `infra-terraform/modules/core_network/dns.tf`
- `kubernetes/ingress.yaml`

**Terraform Resource:** `google_dns_managed_zone`

---

## 9. Resource Manager

**Purpose:** Project-level resource management

**Usage:** Implicit usage by Terraform provider for project configuration

**Terraform Data Source:** `google_client_config`

---

## 10. Workload Identity

**Purpose:** Keyless authentication for GitHub Actions CI/CD

**Configuration:**

- OIDC federation between GitHub and GCP
- Workload Identity Provider for secure authentication
- No service account keys required

**Files:**

- `.github/workflows/deploy.yaml`

**GitHub Actions:**

- `google-github-actions/auth@v2`
- `google-github-actions/setup-gcloud@v2`

---

## Environment Variables

| Variable                         | Description                          |
| -------------------------------- | ------------------------------------ |
| `GCS_BUCKET_NAME`                | Cloud Storage bucket name            |
| `REDIS_URL`                      | Memorystore Redis connection string  |
| `GOOGLE_APPLICATION_CREDENTIALS` | Service account key path (local dev) |
| `GCP_PROJECT_ID`                 | GCP project ID                       |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | OIDC provider for GitHub Actions     |
| `GCP_SA_EMAIL`                   | Service account email                |

---

## NPM Dependencies

| Package                 | Version | Purpose                  |
| ----------------------- | ------- | ------------------------ |
| `@google-cloud/storage` | 7.17.3  | Cloud Storage SDK        |
| `redis`                 | 5.9.0   | Memorystore Redis client |
