"""Per-label cache policy for CLI mode, stored in <data dir>/cli.json.

A label (for example 'Claude (web)') plays the role an endpoint plays in the
web UI: it owns a prune policy, a cache TTL and a context limit, and its name
drives the identity fill. The file is kept apart from settings.json so a
settings save in the web UI can never drop it.
"""
import json
import re
from dataclasses import dataclass

from src.config import APP_DIR, logger
from src.history import atomic_write_json
from src.prune_cache import DEFAULT_CACHE_TTL_SECONDS, clamp_cache_ttl

CLI_SETTINGS_PATH = APP_DIR / 'cli.json'
POLICY_DEFERRED = 'deferred'
POLICY_IMMEDIATE = 'immediate'
POLICIES = (POLICY_DEFERRED, POLICY_IMMEDIATE)
DEFAULT_LABEL = 'Web chat'
DEFAULT_CONTEXT_LIMIT = 200_000
MIN_CONTEXT_LIMIT = 1_000
MAX_CONTEXT_LIMIT = 10_000_000
MAX_LABEL_CHARS = 60
MAX_PROFILES = 200
_TTL_RE = re.compile(r'^(\d+(?:\.\d+)?)\s*([smh]?)$', re.I)
_LIMIT_RE = re.compile(r'^(\d+(?:\.\d+)?)\s*([km]?)$', re.I)
_TTL_UNITS = {'': 1, 's': 1, 'm': 60, 'h': 3600}
_LIMIT_UNITS = {'': 1, 'k': 1_000, 'm': 1_000_000}


class ProfileError(ValueError):
    """An invalid profile value. The message is shown to the user as is."""


def clean_label(value):
    text = ' '.join(str(value or '').split())[:MAX_LABEL_CHARS]
    if not text:
        raise ProfileError('A label cannot be empty.')
    return text


def parse_policy(value):
    text = str(value or '').strip().lower()
    if text not in POLICIES:
        raise ProfileError('Policy must be deferred or immediate.')
    return text


def parse_ttl(value):
    match = _TTL_RE.match(str(value or '').strip())
    if not match:
        raise ProfileError('TTL must be seconds, or use m / h, e.g. 300, 5m or 1h.')
    return clamp_cache_ttl(float(match.group(1)) * _TTL_UNITS[match.group(2).lower()])


def parse_limit(value):
    match = _LIMIT_RE.match(str(value or '').strip())
    if not match:
        raise ProfileError('Limit must be a token count, e.g. 200000, 200k or 1m.')
    number = int(float(match.group(1)) * _LIMIT_UNITS[match.group(2).lower()])
    if not MIN_CONTEXT_LIMIT <= number <= MAX_CONTEXT_LIMIT:
        raise ProfileError(f'Limit must be between {MIN_CONTEXT_LIMIT:,} and {MAX_CONTEXT_LIMIT:,} tokens.')
    return number


_PARSERS = (
    ('prune_policy', parse_policy),
    ('cache_ttl_seconds', parse_ttl),
    ('context_limit', parse_limit),
)


@dataclass
class Profile:
    label: str
    prune_policy: str = POLICY_DEFERRED
    cache_ttl_seconds: int = DEFAULT_CACHE_TTL_SECONDS
    context_limit: int = DEFAULT_CONTEXT_LIMIT

    @property
    def immediate(self):
        return self.prune_policy == POLICY_IMMEDIATE

    def as_policy(self):
        return {'immediate': self.immediate, 'ttl_ms': self.cache_ttl_seconds * 1000, 'limit': self.context_limit}

    def to_dict(self):
        return {'prune_policy': self.prune_policy, 'cache_ttl_seconds': self.cache_ttl_seconds,
                'context_limit': self.context_limit}

    @classmethod
    def from_dict(cls, label, raw):
        profile = cls(label)
        if not isinstance(raw, dict):
            return profile
        for attr, parser in _PARSERS:
            if attr not in raw:
                continue
            try:
                setattr(profile, attr, parser(raw[attr]))
            except ProfileError as e:
                logger.warn(f'Ignoring {attr} for label {label!r} in {CLI_SETTINGS_PATH}: {e}')
        return profile


class ProfileStore:
    """Loads and saves cli.json. A broken file is reported and replaced by defaults."""

    def __init__(self, path=CLI_SETTINGS_PATH):
        self.path = path
        self._data = self._load()

    def _load(self):
        empty = {'profiles': {}, 'last_label': DEFAULT_LABEL}
        if not self.path.exists():
            return empty
        try:
            raw = json.loads(self.path.read_text(encoding='utf-8'))
        except (OSError, ValueError) as e:
            logger.warn(f'Could not read {self.path} ({e}); using default CLI labels')
            return empty
        if not isinstance(raw, dict):
            logger.warn(f'{self.path} is not a JSON object; using default CLI labels')
            return empty
        profiles = raw.get('profiles') if isinstance(raw.get('profiles'), dict) else {}
        return {'profiles': profiles, 'last_label': raw.get('last_label') or DEFAULT_LABEL}

    def get(self, label):
        """The profile for label, with defaults for anything not stored. Raises ProfileError."""
        name = clean_label(label)
        return Profile.from_dict(name, self._data['profiles'].get(name))

    def put(self, profile):
        profiles = self._data['profiles']
        if profile.label not in profiles and len(profiles) >= MAX_PROFILES:
            raise ProfileError(f'At most {MAX_PROFILES} labels can be stored.')
        profiles[profile.label] = profile.to_dict()
        return self.save()

    @property
    def last_label(self):
        try:
            return clean_label(self._data.get('last_label'))
        except ProfileError:
            return DEFAULT_LABEL

    def set_last_label(self, label):
        self._data['last_label'] = clean_label(label)
        return self.save()

    def save(self):
        return atomic_write_json(self.path, {'version': 1, 'profiles': self._data['profiles'],
                                             'last_label': self._data['last_label']})
