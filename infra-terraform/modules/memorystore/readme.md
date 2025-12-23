# Google Memorystore

## Summary

This module allows the user to create Google Memorystore

--- 



## Example usage

```
module "memorystore" {
  source = "./terraform-modules/memorystore"
  name           = "memorystore"
  project_id        = "memorystore"
  memory_size_gb = "1"
}

```

## Inputs

| Name | Description | Type | Default |
|------|-------------|------|---------|
| project_id | The ID of the project in which the resource belongs to. | `string` | n/a |
| region | The GCP region to use. | `string` | `null` | 
| name | The ID of the instance or a fully qualified identifier for the instance. | `string` | n/a | 
| authorized\_network | The full name of the Google Compute Engine network to which the instance is connected. If left unspecified, the default network will be used. | `string` | `null` |
| tier | The service tier of the instance. https://cloud.google.com/memorystore/docs/redis/reference/rest/v1/projects.locations.instances#Tier | `string` | `"STANDARD_HA"` | 
| memory\_size\_gb | Redis memory size in GiB. Defaulted to 1 GiB | `number` | `1` | 
| replica\_count | The number of replicas. can | `number` | `null` | 
| read\_replicas\_mode | Read replicas mode. https://cloud.google.com/memorystore/docs/redis/reference/rest/v1/projects.locations.instances#readreplicasmode | `string` | `"READ_REPLICAS_DISABLED"` |
a zone for the instance. For STANDARD\_HA tier, instances will be created across two zones for protection against zonal failures. If [alternativeLocationId] is also provided, it must be different from [locationId]. | `string` | `null` | 
 alternative\_location\_id | The alternative zone where the instance will be provisioned. | `string` | `null` | 
 | redis\_version | The version of Redis software. | `string` | `null` | 
| redis\_configs | The Redis configuration parameters. See [more details](https://cloud.google.com/memorystore/docs/redis/reference/rest/v1/projects.locations.instances#Instance.FIELDS.redis_configs) | `map(any)` | `{}` | 
| display\_name | An arbitrary and optional user-provided name for the instance. | `string` | `null` | 
| reserved\_ip\_range | The CIDR range of internal addresses that are reserved for this instance. | `string` | `null` | 
| secondary\_ip\_range | Optional. Additional IP range for node placement. Required when enabling read replicas on an existing instance. | `string` | `null` | 
| connect\_mode | The connection mode of the Redis instance. Can be either DIRECT\_PEERING or PRIVATE\_SERVICE\_ACCESS. The default connect mode if not provided is DIRECT\_PEERING. | `string` | `null` | 
| labels | The resource labels to represent user provided metadata. | `map(string)` | `null` |
| auth\_enabled | Indicates whether OSS Redis AUTH is enabled for the instance. If set to true AUTH is enabled on the instance. | `bool` | `false` | 
| transit\_encryption\_mode | The TLS mode of the Redis instance, If not provided, TLS is enabled for the instance. | `string` | `"SERVER_AUTHENTICATION"` | 
| maintenance\_policy | The maintenance policy for an instance. | <pre>object({<br>    day = string<br>    start_time = object({<br>      hours   = number<br>      minutes = number<br>      seconds = number<br>      nanos   = number<br>    })<br>  })</pre> | `null` |
| customer\_managed\_key | Default encryption key to apply to the Redis instance. Defaults to null (Google-managed). | `string` | `null` | 
| persistence\_config | The Redis persistence configuration parameters. https://cloud.google.com/memorystore/docs/redis/reference/rest/v1/projects.locations.instances#persistenceconfig | <pre>object({<br>    persistence_mode    = string<br>    rdb_snapshot_period = string<br>  })</pre> | `null` | 


## Outputs

| Name | Description |
|------|-------------|
| auth\_string | AUTH String set on the instance. This field will only be populated if auth\_enabled is true. |
| current\_location\_id | The current zone where the Redis endpoint is placed. |
| host | The IP address of the instance. |
| id | The memorystore instance ID. |
| persistence\_iam\_identity | Cloud IAM identity used by import/export operations. Format is 'serviceAccount:'. May change over time |
| port | The port number of the exposed Redis endpoint. |
| read\_endpoint | The IP address of the exposed readonly Redis endpoint. |
| region | The region the instance lives in. |
| server\_ca\_certs | List of server CA certificates for the instance |

