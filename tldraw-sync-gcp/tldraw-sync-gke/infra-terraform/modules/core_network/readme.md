# core_network

## Summary

This module allows the user to create network (vpc and subnets)

---

## Example usage for creating regular vpc

```
module "network" {
  source     = "../terraform-modules/core_network"
  project_id = "zazmic-observability-lower-002"
  project_name = "zazmic-observability-lower-002"
  region     = "us-west1"
  subnets = [
    {
        name = "private-subnet"
        cidr = "10.2.0.0/16"
        region = "us-west1"
        allow_nat = false
        secondary_ip_range = [{
            range_name    = "tf-test-secondary-range"
            ip_cidr_range = "192.168.10.0/24"
        }]
    }
    ,{
        name = "public-subnet"
        cidr = "10.8.0.0/16"
        region = "us-west1"
        allow_nat = true
        secondary_ip_range = [{
            range_name    = "tf-test-secondary-range-2"
            ip_cidr_range = "192.168.125.0/24"
        }]
    }
  ]

}

```

## Example usage for creating shared vpc

you need to set **enable_shared_vpc** = **true** and add **service_projects** list

```
module "network" {
  source     = "../terraform-modules/core_network"
  project_id = "zazmic-devops-sandbox"
  project_name = "zazmic-devops-sandbox"
  enable_shared_vpc = true
  service_projects = [{
    id = "zazmic-observability-lower-002",
    name = "zazmic-observability-lower-002",
    type = "service"
  }]
  region     = "us-west1"
  subnets = [
    {
        name = "private-subnet"
        cidr = "10.2.0.0/16"
        region = "us-west1"
        allow_nat = false
        secondary_ip_range = [{
            range_name    = "tf-test-secondary-range"
            ip_cidr_range = "192.168.10.0/24"
        }]
    }
    ,{
        name = "public-subnet"
        cidr = "10.8.0.0/16"
        region = "us-west1"
        allow_nat = true
        secondary_ip_range = [{
            range_name    = "tf-test-secondary-range-2"
            ip_cidr_range = "192.168.125.0/24"
        }]
    }
  ]

}

```
