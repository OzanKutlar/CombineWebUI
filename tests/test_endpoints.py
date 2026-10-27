import asyncio
import importlib.util
import unittest
from unittest import mock

from src import endpoints
from src.config import state

HAS_FASTAPI = importlib.util.find_spec('fastapi') is not None


def endpoint(name, url='http://localhost:9000/v1', **extra):
    ep = {'name': name, 'url': url, 'api_key': 'sk-test', 'logo': '', 'models': []}
    ep.update(extra)
    return ep


SETTINGS = {'custom_endpoints': [
    endpoint('Default'),
    endpoint('On', enabled=True),
    endpoint('Off', enabled=False),
    endpoint('NoUrl', url=''),
]}


class ConfiguredEndpointTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(endpoints, 'load_settings', return_value=SETTINGS)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_inactive_endpoints_are_dropped(self):
        names = [ep['name'] for ep in endpoints._configured_endpoints()]
        self.assertEqual(names, ['Default', 'On'])

    def test_missing_flag_means_active(self):
        self.assertTrue(endpoints.is_endpoint_enabled({}))
        self.assertTrue(endpoints.is_endpoint_enabled({'enabled': True}))
        self.assertFalse(endpoints.is_endpoint_enabled({'enabled': False}))
        self.assertFalse(endpoints.is_endpoint_enabled(None))

    def test_cache_models_never_contacts_an_inactive_endpoint(self):
        contacted = []

        async def fake_fetch(ep):
            contacted.append(ep['name'])
            return [{'id': ep['name'] + '-model', '_endpoint_name': ep['name']}]

        previous = state.models
        self.addCleanup(setattr, state, 'models', previous)
        with mock.patch.object(endpoints, 'fetch_endpoint_models', new=fake_fetch):
            models = asyncio.run(endpoints.cache_models())
        self.assertEqual(sorted(contacted), ['Default', 'On'])
        self.assertEqual(sorted(m['id'] for m in models), ['Default-model', 'On-model'])


@unittest.skipUnless(HAS_FASTAPI, 'FastAPI is not installed')
class ProviderGroupTests(unittest.TestCase):
    def test_inactive_endpoint_adds_no_group(self):
        from src.server import _merged_providers
        settings = {'providers': [], 'custom_endpoints': [endpoint('On'), endpoint('Off', enabled=False)]}
        self.assertEqual([p['id'] for p in _merged_providers(settings)], ['On'])


if __name__ == '__main__':
    unittest.main()
