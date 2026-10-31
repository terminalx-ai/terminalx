import importlib.util
import plistlib
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("restore_metadata", Path(__file__).with_name("macos-restore-metadata.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture(record=None, model="VirtualMac2,1"):
    record = record or {"ProductVersion": "26.0", "BuildVersion": "Fixture26", "FirmwareURL": "https://updates.cdn-apple.com/fixture.ipsw"}
    return plistlib.dumps({"MobileDeviceSoftwareVersionsByVersion": {"1": {"MobileDeviceSoftwareVersions": {model: {"build": {"Restore": record}}}}}})


class RestoreMetadataTests(unittest.TestCase):
    def test_candidate_is_not_verified_artifact_or_catalog_entry(self):
        with patch.object(module, "fetch_metadata", side_effect=AssertionError("unexpected network")):
            result = module.inspect_metadata(fixture())
        self.assertEqual(result["source"], "offline-input-origin-unverified")
        self.assertFalse(result["catalogEntryEligible"])
        self.assertFalse(result["imageDownloaded"])
        self.assertIsNone(result["candidates"][0]["verifiedImageSha256"])

    def test_no_os_upgrade_or_hardware_model_fallback(self):
        for raw in [fixture({"ProductVersion": "27.2", "BuildVersion": "Fixture27", "FirmwareURL": "https://updates.cdn-apple.com/later.ipsw"}), fixture(model="Macmini9,1")]:
            result = module.inspect_metadata(raw)
            self.assertEqual(result["result"], "no-macos26-candidate")
            self.assertEqual(result["candidates"], [])

    def test_wrong_origin_credentials_or_malformed_versions_refused(self):
        for url in ["https://updates.cdn-apple.com.evil.invalid/a.ipsw", "http://updates.cdn-apple.com/a.ipsw", "https://user@updates.cdn-apple.com/a.ipsw", "https://updates.cdn-apple.com/a.ipsw?token=secret"]:
            with self.assertRaises(ValueError):
                module.inspect_metadata(fixture({"ProductVersion": "26", "BuildVersion": "Fixture", "FirmwareURL": url}))
        with self.assertRaises(ValueError):
            module.inspect_metadata(fixture({"ProductVersion": "26-latest"}))

    def test_conflicting_original_metadata_is_not_silently_selected(self):
        data = plistlib.loads(fixture())
        records = data["MobileDeviceSoftwareVersionsByVersion"]["1"]["MobileDeviceSoftwareVersions"][module.MODEL]
        records["replacement"] = {"Restore": dict(records["build"]["Restore"], FirmwareURL="https://updates.cdn-apple.com/replaced.ipsw")}
        with self.assertRaises(ValueError):
            module.inspect_metadata(plistlib.dumps(data))

    def test_publisher_sha1_is_not_promoted_to_verified_sha256(self):
        record = {"ProductVersion": "26.1", "BuildVersion": "Fixture26", "FirmwareURL": "https://updates.cdn-apple.com/fixture.ipsw", "FirmwareSHA1": "a" * 40}
        candidate = module.inspect_metadata(fixture(record))["candidates"][0]
        self.assertEqual(candidate["publisherSha1"], "a" * 40)
        self.assertIsNone(candidate["verifiedImageSha256"])

    def test_bounds_and_redirects_refuse(self):
        with self.assertRaises(ValueError):
            module.inspect_metadata(b"x" * (module.LIMIT + 1))
        with self.assertRaises(ValueError):
            module.NoRedirect().redirect_request(None, None, 302, None, None, "https://updates.cdn-apple.com/image.ipsw")

    def test_fetch_uses_only_fixed_metadata_url_and_bounded_read(self):
        from unittest.mock import MagicMock
        opener = MagicMock()
        response = opener.open.return_value.__enter__.return_value
        response.status, response.url = 200, module.CATALOG_URL
        response.read.return_value = fixture()
        with patch.object(module.urllib.request, "build_opener", return_value=opener):
            result = module.inspect_metadata(module.fetch_metadata(), fetched=True)
        opener.open.assert_called_once_with(module.CATALOG_URL, timeout=15)
        response.read.assert_called_once_with(module.LIMIT + 1)
        self.assertFalse(result["imageDownloaded"])
        self.assertFalse(result["catalogEntryEligible"])


if __name__ == "__main__":
    unittest.main()
