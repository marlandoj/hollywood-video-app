#!/usr/bin/env python3
"""Create the configured private S3 bucket, enforce public-access blocking and declare its lifecycle rule."""
import json, os, time
from urllib.parse import urlparse
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, EndpointConnectionError

# Matches the sweeper's 24-hour application grace for incomplete multipart uploads (docs/STORAGE-RETENTION.md).
LIFECYCLE_RULE = {"ID": "abort-incomplete-multipart-uploads", "Status": "Enabled", "Filter": {"Prefix": ""},
    "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}}
UNSUPPORTED_LIFECYCLE_CODES = {"NotImplemented", "MalformedXML", "UnsupportedOperation", "OperationNotSupported", "NotSupported", "MethodNotAllowed"}

def declare_lifecycle(client, bucket):
    """Return "declared" after a verified read-back, "unsupported" when the store lacks the API; anything else raises."""
    try:
        client.put_bucket_lifecycle_configuration(Bucket=bucket, LifecycleConfiguration={"Rules": [LIFECYCLE_RULE]})
        observed = client.get_bucket_lifecycle_configuration(Bucket=bucket).get("Rules", [])
    except ClientError as error:
        if error.response["Error"]["Code"] in UNSUPPORTED_LIFECYCLE_CODES: return "unsupported"
        raise
    if len(observed) != 1 or observed[0].get("Status") != "Enabled" \
            or observed[0].get("AbortIncompleteMultipartUpload") != LIFECYCLE_RULE["AbortIncompleteMultipartUpload"]:
        raise RuntimeError("bucket lifecycle rule was not applied as declared")
    return "declared"

def prepare():
    endpoint = os.environ["HV_S3_ENDPOINT"]
    parsed = urlparse(endpoint)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")):
        raise RuntimeError("S3 setup requires HTTPS")
    bucket = os.environ["HV_S3_BUCKET"]
    client = boto3.client("s3", endpoint_url=endpoint, region_name=os.environ.get("HV_S3_REGION","us-east-1"),
        aws_access_key_id=os.environ["HV_S3_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["HV_S3_SECRET_ACCESS_KEY"],
        verify=os.environ.get("HV_STORAGE_CA_PATH", True),
        config=Config(signature_version="s3v4", s3={"addressing_style":"path"}, connect_timeout=3, read_timeout=10, retries={"max_attempts":2}))
    for attempt in range(30):
        try:
            client.create_bucket(Bucket=bucket)
            break
        except ClientError as error:
            if error.response["Error"]["Code"] == "BucketAlreadyOwnedByYou": break
            raise
        except EndpointConnectionError:
            if attempt == 29: raise
            time.sleep(1)
    settings = {"BlockPublicAcls":True,"IgnorePublicAcls":True,"BlockPublicPolicy":True,"RestrictPublicBuckets":True}
    client.put_public_access_block(Bucket=bucket, PublicAccessBlockConfiguration=settings)
    observed = client.get_public_access_block(Bucket=bucket)["PublicAccessBlockConfiguration"]
    if observed != settings: raise RuntimeError("bucket public access blocking was not applied")
    # The lifecycle declaration runs after the verified block and never touches it.
    lifecycle = declare_lifecycle(client, bucket)
    print(json.dumps({"bucket":bucket,"publicAccessBlocked":True,"bucketLifecycle":lifecycle}))
if __name__ == "__main__": prepare()
