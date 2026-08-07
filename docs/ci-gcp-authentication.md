# Google Cloud authentication in CI

`.github/workflows/deploy-gke.yaml` authenticates with **Workload Identity Federation**, so there are no service account keys anywhere — GitHub mints a short-lived OIDC token, Google exchanges it for a federated one, and that impersonates a service account. Nothing long-lived is stored.

Three repository secrets are required.

| Secret                           | What it is                                | Sensitive?                                 |
| -------------------------------- | ----------------------------------------- | ------------------------------------------ |
| `GCP_PROJECT_ID`                 | The project ID, e.g. `tldraw-sync-demo`   | No, but conventionally kept here           |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full resource path of the OIDC provider   | No — it is an identifier, not a credential |
| `GCP_SA_EMAIL`                   | Service account the workflow impersonates | No                                         |

None of these is a credential. The security boundary is the **attribute condition** on the provider, which decides which repository is allowed to use it — not the secrecy of these strings.

## The failure this document exists for

```
failed to generate Google Cloud federated token for //iam.googleapis.com/...:
{"error":"invalid_target","error_description":"The target service indicated by
the \"audience\" parameters is invalid. This might either be because the pool or
provider is disabled or deleted or because it doesn't exist."}
```

`invalid_target` means `GCP_WORKLOAD_IDENTITY_PROVIDER` names something that is not there. Usually one of:

- the pool or provider was deleted, or the whole project was rebuilt
- the value uses the **project ID** where the path requires the **project number**
- the value is a bare pool name rather than the full resource path
- the pool is soft-deleted — deleted pools are recoverable for 30 days and keep the name reserved

It is **not** a permissions problem. Permission errors look different, and they happen later.

## Setting it up

```bash
PROJECT_ID="your-project-id"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
GITHUB_ORG="tldraw"
REPO="tldraw/tldraw-sync-cloud"
SA_NAME="github-actions-deployer"

gcloud services enable \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  container.googleapis.com \
  artifactregistry.googleapis.com \
  --project="$PROJECT_ID"

# 1. The pool
gcloud iam workload-identity-pools create "github" \
  --project="$PROJECT_ID" \
  --location="global" \
  --display-name="GitHub Actions Pool"

# 2. The provider. The attribute condition is the security boundary: without it
#    any GitHub repository anywhere could exchange a token against this provider.
gcloud iam workload-identity-pools providers create-oidc "tldraw-sync-cloud" \
  --project="$PROJECT_ID" \
  --location="global" \
  --workload-identity-pool="github" \
  --display-name="tldraw-sync-cloud" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository_owner == '${GITHUB_ORG}'" \
  --issuer-uri="https://token.actions.githubusercontent.com"

# 3. The service account the workflow acts as
gcloud iam service-accounts create "$SA_NAME" \
  --project="$PROJECT_ID" \
  --display-name="GitHub Actions deployer"

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# 4. Let *only this repository* impersonate it
POOL_ID="$(gcloud iam workload-identity-pools describe github \
  --project="$PROJECT_ID" --location=global --format='value(name)')"

gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.repository/${REPO}"
```

Then the value for the secret:

```bash
echo "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/tldraw-sync-cloud"
```

Note **`PROJECT_NUMBER`**, not the project ID. Using the ID is the single most common cause of `invalid_target`.

## Permissions the service account needs

Grant on the project:

| Role                            | Why                                                                        |
| ------------------------------- | -------------------------------------------------------------------------- |
| `roles/artifactregistry.writer` | Push the built image to Artifact Registry                                  |
| `roles/container.developer`     | Manage workloads in the cluster, and read the cluster to fetch credentials |

```bash
for role in roles/artifactregistry.writer roles/container.developer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$role"
done
```

That is the whole set for the current workflow, which builds an image, pushes it, applies the ServiceAccount manifest and rolls the Deployment. `roles/container.developer` covers `container.clusters.get`, so no separate `roles/container.clusterViewer` is needed. Do **not** grant `roles/owner` or `roles/editor` — a federated identity scoped to one repository with two narrow roles is the entire point of this setup.

If you later have CI run `terraform apply` for the new deployment targets, that needs considerably more (`roles/compute.admin`, `roles/redis.admin`, `roles/storage.admin`, `roles/iam.serviceAccountAdmin`, `roles/resourcemanager.projectIamAdmin`). Use a **separate** service account for it rather than widening this one — the deploy identity should not be able to rewrite the project's IAM policy.

## Reaching a private control plane

The cluster is private (`enable_private_endpoint = true`) with authorized networks limited to `10.40.0.0/16`, and GitHub-hosted runners are not in that range. The workflow handles this with:

```
gcloud container clusters get-credentials "$GKE_CLUSTER" --region "$REGION" --dns-endpoint
```

The DNS-based endpoint is gated by IAM rather than by source IP, so it works from a runner without a bastion, a VPN, or adding runner IPs to the authorized networks list. It requires the cluster to allow external traffic to that endpoint, which the Terraform already does — `gke.tf` sets `deploy_using_private_endpoint = true`, which the module turns into `dns_endpoint_config.allow_external_traffic`.

Confirm it is on:

```bash
gcloud container clusters describe "$GKE_CLUSTER" --region "$REGION" \
  --format='value(controlPlaneEndpointsConfig.dnsEndpointConfig.allowExternalTraffic)'
```

If that prints `False`, `get-credentials` will fail _after_ authentication succeeds — a different error with a different fix.

## Verifying

Re-run the workflow, or exercise the exchange locally with the `gh` CLI:

```bash
gcloud iam workload-identity-pools providers describe tldraw-sync-cloud \
  --project="$PROJECT_ID" --location=global --workload-identity-pool=github \
  --format='value(state)'          # expect ACTIVE, not DELETED

gcloud iam service-accounts get-iam-policy "$SA_EMAIL" --project="$PROJECT_ID"
```

The workflow's first step now fails fast and names any secret that is missing or malformed, rather than letting it surface as `invalid_target` two steps later.

## A note on the unused `REDIS_IP` secret

The repository also has a `REDIS_IP` secret, which **no workflow reads**. It dates from the manual `envsubst` deployment flow in `tldraw-sync-gcp/tldraw-sync-gke/docs/manual-gcp-deployment.md`, where `kubernetes/deployment.yaml`'s `${REDIS_IP}` placeholder is substituted by hand. CI only ever runs `kubectl set image` against an already-applied Deployment, so it never needs it.

Either delete the secret, or move the manifest application into CI so the deployment is reproducible from the repository rather than from someone's shell history. The latter is the better end state but changes what a merge to `main` does, so it should be a deliberate decision rather than a side effect.
