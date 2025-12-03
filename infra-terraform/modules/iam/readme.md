# Project Role Members Terraform Module

This module allows granting IAM roles to multiple members at the project level and on certain resources like service accounts,subnets and buckets. It is member-oriented, focusing on attaching multiple roles to members rather than multiple members to roles.
Feel free to contribute to this module to add another resources like datasets, instances.. etc

### Basic example 

Basic usage granting project-level roles to specific groups:

```tf
module "project_roles" {
  source = "../../modules/iam"  
  project_name = "intello-transit"
  member_roles = {
    "group:gcp-foo@zazmic.com" :[

    "roles/viewer",
   
 ] 
    "group:intello-developers@zazmic.com " :[
    "roles/editor",
 ] 
  }
}
```
### Resources
Additionally, a few resource types are supported on specific resources as opposed to default project-wide role.

```tf
module "project_roles" {
  source = "../../modules/iam"  
  project_name = "intello-transit"
  member_roles = {
    "group:gcp-foo@zazmic.com" :[

    "roles/viewer",
    #the line below grants thepermission to the referenced SA
    "roles/iam.serviceAccountUser > service_account > 1005661200539-compute@developer.gserviceaccount.com"
   
 ] 
    "group:intello-developers@zazmic.com " :[
    "roles/editor",
 ] 
  }
}
```