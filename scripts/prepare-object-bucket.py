#!/usr/bin/env python3
"""Create the configured private S3 bucket and enforce public-access blocking."""
import json, os, time
from urllib.parse import urlparse
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, EndpointConnectionError

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
    print(json.dumps({"bucket":bucket,"publicAccessBlocked":True}))
if __name__ == "__main__": prepare()
