# Terraform Service Accounts Module

This module allows easy creation of one or more service accounts, and granting them basic roles.

The resources/services/activations/deletions that this module will create/trigger are:

- one or more service accounts
- optional project-level IAM role bindings for each service account
- one optional billing IAM role binding per service account, at the organization or billing account level
- two optional organization-level IAM bindings per service account, to enable the service accounts to create and manage Shared VPC networks
- one optional service account key per service account

## Compatibility

This module is meant for use with Terraform 0.13+ and tested using Terraform 1.0+. If you find incompatibilities using Terraform >=0.13, please open an issue.
If you haven't
[upgraded](https://www.terraform.io/upgrade-guides/0-13.html) and need a Terraform
0.12.x-compatible version of this module, the last released version
intended for Terraform 0.12.x is [v3.0.1](https://registry.terraform.io/modules/terraform-google-modules/-service-accounts/google/v3.0.1).

## Usage

Basic usage of this module is as follows:

```hcl
module "service_accounts" {
  source        = "terraform-google-modules/service-accounts/google"
  version       = "~> 3.0"
  project_id    = "<PROJECT ID>"
  prefix        = "test-sa"
  names         = ["first", "second"]
  project_roles = [
    "project-foo=>roles/viewer",
    "project-spam=>roles/storage.objectViewer",
  ]
}
```

Functional examples are included in the
[examples](./examples/) directory.

<!-- BEGINNING OF PRE-COMMIT-TERRAFORM DOCS HOOK -->

## Inputs

| Name               | Description                                                                                                | Type           | Default                               | Required |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------- | :------: |
| billing_account_id | If assigning billing role, specificy a billing account (default is to assign at the organizational level). | `string`       | `""`                                  |    no    |
| description        | Default description of the created service accounts (defaults to no description)                           | `string`       | `""`                                  |    no    |
| descriptions       | List of descriptions for the created service accounts (elements default to the value of `description`)     | `list(string)` | `[]`                                  |    no    |
| display_name       | Display names of the created service accounts (defaults to 'Terraform-managed service account')            | `string`       | `"Terraform-managed service account"` |    no    |
| generate_keys      | Generate keys for service accounts.                                                                        | `bool`         | `false`                               |    no    |
| grant_billing_role | Grant billing user role.                                                                                   | `bool`         | `false`                               |    no    |
| grant_xpn_roles    | Grant roles for shared VPC management.                                                                     | `bool`         | `true`                                |    no    |
| names              | Names of the service accounts to create.                                                                   | `list(string)` | `[]`                                  |    no    |
| org_id             | Id of the organization for org-level roles.                                                                | `string`       | `""`                                  |    no    |
| prefix             | Prefix applied to service account names.                                                                   | `string`       | `""`                                  |    no    |
| project_id         | Project id where service account will be created.                                                          | `string`       | n/a                                   |   yes    |
| project_roles      | Common roles to apply to all service accounts, project=>role as elements.                                  | `list(string)` | `[]`                                  |    no    |

## Outputs

| Name                 | Description                                        |
| -------------------- | -------------------------------------------------- |
| email                | Service account email (for single use).            |
| emails               | Service account emails by name.                    |
| emails_list          | Service account emails as list.                    |
| iam_email            | IAM-format service account email (for single use). |
| iam_emails           | IAM-format service account emails by name.         |
| iam_emails_list      | IAM-format service account emails as list.         |
| key                  | Service account key (for single use).              |
| keys                 | Map of service account keys.                       |
| service_account      | Service account resource (for single use).         |
| service_accounts     | Service account resources as list.                 |
| service_accounts_map | Service account resources by name.                 |

<!-- END OF PRE-COMMIT-TERRAFORM DOCS HOOK -->

## Requirements

These sections describe requirements for using this module.

### Software

The following dependencies must be available:

- [Terraform](https://www.terraform.io/downloads.html) >= 0.13.0
- [Terraform Provider for GCP][terraform-provider-gcp] plugin >= v2.0

### IAM

Service account or user credentials with the following roles must be used to provision the resources of this module:

- Service Account Admin: `roles/iam.serviceAccountAdmin`
- (optional) Service Account Key Admin: `roles/iam.serviceAccountKeyAdmin` when `generate_keys` is set to `true`
- (optional) roles needed to grant optional IAM roles at the project or organizational level

## Contributing

Refer to the [contribution guidelines](./CONTRIBUTING.md) for
information on contributing to this module.

[iam-module]: https://registry.terraform.io/modules/terraform-google-modules/iam/google
[project-factory-module]: https://registry.terraform.io/modules/terraform-google-modules/project-factory/google
[terraform-provider-gcp]: https://www.terraform.io/docs/providers/google/index.html
[terraform]: https://www.terraform.io/downloads.html
