import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

# The script imports boto3 at module level. CI's system interpreter may lack it (the bucket step
# uses a venv), so install minimal stand-ins only when the real packages are absent.
try:
    import boto3  # noqa: F401
    import botocore.config  # noqa: F401
    import botocore.exceptions  # noqa: F401
except ImportError:
    class _ClientError(Exception):
        def __init__(self, error_response, operation_name):
            super().__init__(f"{operation_name}: {error_response['Error']['Code']}")
            self.response = error_response
            self.operation_name = operation_name
    class _EndpointConnectionError(Exception): pass
    boto3_stub = types.ModuleType("boto3"); boto3_stub.client = MagicMock(name="boto3.client")
    botocore_stub = types.ModuleType("botocore")
    config_stub = types.ModuleType("botocore.config"); config_stub.Config = MagicMock(name="Config")
    exceptions_stub = types.ModuleType("botocore.exceptions")
    exceptions_stub.ClientError = _ClientError; exceptions_stub.EndpointConnectionError = _EndpointConnectionError
    sys.modules.update({"boto3": boto3_stub, "botocore": botocore_stub, "botocore.config": config_stub, "botocore.exceptions": exceptions_stub})

spec = importlib.util.spec_from_file_location("prepare_object_bucket", Path(__file__).with_name("prepare-object-bucket.py"))
bucket = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bucket)
ClientError = bucket.ClientError

ENV = {"HV_S3_ENDPOINT": "http://127.0.0.1:59000", "HV_S3_BUCKET": "rough-cut-ci", "HV_S3_REGION": "us-east-1",
    "HV_S3_ACCESS_KEY_ID": "ci-storage-fixture", "HV_S3_SECRET_ACCESS_KEY": "ci-storage-fixture-secret-only"}
BLOCK = {"BlockPublicAcls": True, "IgnorePublicAcls": True, "BlockPublicPolicy": True, "RestrictPublicBuckets": True}

def client_error(code, operation="PutBucketLifecycleConfiguration"):
    return ClientError({"Error": {"Code": code, "Message": code}}, operation)

def stub_client(lifecycle_rules=None, put_error=None, get_error=None):
    client = MagicMock(name="s3")
    client.get_public_access_block.return_value = {"PublicAccessBlockConfiguration": dict(BLOCK)}
    if put_error is not None: client.put_bucket_lifecycle_configuration.side_effect = put_error
    if get_error is not None: client.get_bucket_lifecycle_configuration.side_effect = get_error
    else: client.get_bucket_lifecycle_configuration.return_value = {"Rules": lifecycle_rules if lifecycle_rules is not None else [dict(bucket.LIFECYCLE_RULE)]}
    return client

def run_prepare(client):
    output = io.StringIO()
    with patch.dict(os.environ, ENV, clear=False), patch.object(bucket.boto3, "client", return_value=client), contextlib.redirect_stdout(output):
        bucket.prepare()
    lines = [line for line in output.getvalue().splitlines() if line.strip()]
    return json.loads(lines[-1])

class LifecycleDeclarationTests(unittest.TestCase):
    def test_lifecycle_is_put_with_exactly_one_abort_rule_of_one_day_and_read_back(self):
        client = stub_client()
        report = run_prepare(client)
        self.assertEqual(report, {"bucket": "rough-cut-ci", "publicAccessBlocked": True, "bucketLifecycle": "declared"})
        client.put_bucket_lifecycle_configuration.assert_called_once()
        rules = client.put_bucket_lifecycle_configuration.call_args.kwargs["LifecycleConfiguration"]["Rules"]
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["AbortIncompleteMultipartUpload"], {"DaysAfterInitiation": 1})
        self.assertEqual(rules[0]["Status"], "Enabled")
        self.assertNotIn("Expiration", rules[0])
        client.get_bucket_lifecycle_configuration.assert_called_once_with(Bucket="rough-cut-ci")
        self.assertPublicAccessVerified(client)

    def test_unsupported_store_reports_unsupported_and_still_verifies_the_public_access_block(self):
        for code in ("NotImplemented", "MalformedXML", "UnsupportedOperation"):
            with self.subTest(code=code):
                client = stub_client(put_error=client_error(code))
                report = run_prepare(client)  # Returns normally: a zero exit for __main__.
                self.assertEqual(report["bucketLifecycle"], "unsupported")
                self.assertTrue(report["publicAccessBlocked"])
                client.get_bucket_lifecycle_configuration.assert_not_called()
                self.assertPublicAccessVerified(client)
        client = stub_client(get_error=client_error("NotImplemented", "GetBucketLifecycleConfiguration"))
        self.assertEqual(run_prepare(client)["bucketLifecycle"], "unsupported")
        self.assertPublicAccessVerified(client)

    def test_other_lifecycle_errors_and_mismatched_read_back_raise(self):
        with self.assertRaises(ClientError):
            run_prepare(stub_client(put_error=client_error("AccessDenied")))
        for observed in ([], [{"ID": "x", "Status": "Enabled", "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}}],
                         [{"ID": "x", "Status": "Disabled", "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}}],
                         [dict(bucket.LIFECYCLE_RULE), {"ID": "y", "Status": "Enabled", "Expiration": {"Days": 30}}],
                         [{"ID": "x", "Status": "Enabled", "Expiration": {"Days": 1}}]):
            with self.subTest(observed=observed), self.assertRaisesRegex(RuntimeError, "lifecycle rule was not applied"):
                run_prepare(stub_client(lifecycle_rules=observed))

    def test_public_access_block_failure_still_raises_before_any_lifecycle_call(self):
        client = stub_client()
        client.get_public_access_block.return_value = {"PublicAccessBlockConfiguration": dict(BLOCK, BlockPublicPolicy=False)}
        with self.assertRaisesRegex(RuntimeError, "public access blocking"):
            run_prepare(client)
        client.put_bucket_lifecycle_configuration.assert_not_called()

    def test_endpoint_rule_is_unchanged(self):
        with patch.dict(os.environ, dict(ENV, HV_S3_ENDPOINT="http://objects.example:9000")), self.assertRaisesRegex(RuntimeError, "HTTPS"):
            bucket.prepare()

    def assertPublicAccessVerified(self, client):
        client.put_public_access_block.assert_called_once_with(Bucket="rough-cut-ci", PublicAccessBlockConfiguration=BLOCK)
        client.get_public_access_block.assert_called_once_with(Bucket="rough-cut-ci")
        for call in client.put_public_access_block.call_args_list:
            self.assertEqual(call.kwargs["PublicAccessBlockConfiguration"], BLOCK)

if __name__ == "__main__": unittest.main()
